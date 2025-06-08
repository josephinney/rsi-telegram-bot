import dotenv from 'dotenv';
dotenv.config();

import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';

// Tipos de datos
interface KlineData {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
  quoteAssetVolume: string;
  numberOfTrades: number;
  takerBuyBaseAssetVolume: string;
  takerBuyQuoteAssetVolume: string;
  ignore: string;
}

interface UserConfig {
  chatId: number;
  rsiThresholds: {
    oversold: number; // Por debajo de este valor (ej: 30)
    overbought: number; // Por encima de este valor (ej: 70)
  };
  alertsEnabled: boolean;
  lastAlertTime: number; // Para evitar spam
  channels: string[]; // Lista de canales donde enviar alertas (ej: "@mi_canal" o "-1001234567890")
}

interface RSIData {
  value: number;
  timestamp: number;
  price: number;
}

// Configuración
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'TU_TOKEN_AQUI';
const BINANCE_API_URL = 'https://api.binance.com/api/v3';
const RSI_PERIOD = 14; // Período estándar para RSI
const CHECK_INTERVAL = 10000; // 10 segundos entre verificaciones (para velas de 5min)
const ALERT_COOLDOWN = 300000; // 5 minutos entre alertas del mismo tipo

// Verificar que el token esté configurado
if (TELEGRAM_TOKEN === 'TU_TOKEN_AQUI') {
  console.error('❌ ERROR: Token de Telegram no configurado');
  console.error('   Configura TELEGRAM_BOT_TOKEN en tu archivo .env o directamente en el código');
  process.exit(1);
}

// Storage en memoria (en producción usar base de datos)
const userConfigs: Map<number, UserConfig> = new Map();
let lastRSIValue: RSIData | null = null;

// Inicializar bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Verificar conexión del bot
bot.getMe().then((botInfo) => {
  console.log('✅ Bot conectado correctamente:', botInfo.username);
  console.log('🔗 ID del bot:', botInfo.id);
}).catch((error) => {
  console.error('❌ Error conectando bot:', error.message);
  console.error('🔍 Verifica que tu token sea correcto');
  process.exit(1);
});

/**
 * Obtiene datos de velas (klines) de Binance para BTC/USDT
 * @param interval - Intervalo de tiempo (ej: '1h', '4h', '1d')
 * @param limit - Número de velas a obtener
 * @returns Promise con array de datos de velas
 */
async function getBinanceKlines(interval: string = '1h', limit: number = 100): Promise<KlineData[]> {
  try {
    const url = `${BINANCE_API_URL}/klines`;
    const params = {
      symbol: 'BTCUSDT',
      interval: interval,
      limit: limit
    };
    
    const response = await axios.get(url, { params });
    
    // Transformar respuesta de Binance al formato tipado
    return response.data.map((kline: any[]): KlineData => ({
      openTime: kline[0],
      open: kline[1],
      high: kline[2],
      low: kline[3],
      close: kline[4],
      volume: kline[5],
      closeTime: kline[6],
      quoteAssetVolume: kline[7],
      numberOfTrades: kline[8],
      takerBuyBaseAssetVolume: kline[9],
      takerBuyQuoteAssetVolume: kline[10],
      ignore: kline[11]
    }));
  } catch (error) {
    console.error('Error obteniendo datos de Binance:', error);
    throw new Error('No se pudieron obtener datos de Binance');
  }
}

/**
 * Calcula el RSI (Relative Strength Index) basado en precios de cierre
 * @param prices - Array de precios de cierre
 * @param period - Período para el cálculo (generalmente 14)
 * @returns Valor del RSI (0-100)
 */
function calculateRSI(prices: number[], period: number = RSI_PERIOD): number {
  if (prices.length < period + 1) {
    throw new Error(`Se necesitan al menos ${period + 1} precios para calcular RSI`);
  }

  const gains: number[] = [];
  const losses: number[] = [];

  // Calcular ganancias y pérdidas
  for (let i = 1; i < prices.length; i++) {
    const difference = prices[i] - prices[i - 1];
    gains.push(difference > 0 ? difference : 0);
    losses.push(difference < 0 ? Math.abs(difference) : 0);
  }

  // Calcular promedio inicial (SMA)
  const initialAvgGain = gains.slice(0, period).reduce((sum, gain) => sum + gain, 0) / period;
  const initialAvgLoss = losses.slice(0, period).reduce((sum, loss) => sum + loss, 0) / period;

  let avgGain = initialAvgGain;
  let avgLoss = initialAvgLoss;

  // Calcular EMA para el resto de los períodos
  for (let i = period; i < gains.length; i++) {
    avgGain = ((avgGain * (period - 1)) + gains[i]) / period;
    avgLoss = ((avgLoss * (period - 1)) + losses[i]) / period;
  }

  // Evitar división por cero
  if (avgLoss === 0) {
    return 100;
  }

  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));

  return Math.round(rsi * 100) / 100; // Redondear a 2 decimales
}

/**
 * Obtiene el RSI actual de BTC/USDT
 * @returns Objeto con datos del RSI actual
 */
async function getCurrentRSI(): Promise<RSIData> {
  const klines = await getBinanceKlines('5m', RSI_PERIOD + 10); // Velas de 5 minutos
  const closePrices = klines.map(kline => parseFloat(kline.close));
  
  const rsiValue = calculateRSI(closePrices);
  const currentPrice = closePrices[closePrices.length - 1];
  
  return {
    value: rsiValue,
    timestamp: Date.now(),
    price: currentPrice
  };
}

/**
 * Verifica si debe enviar alerta basada en configuración del usuario
 * @param userConfig - Configuración del usuario
 * @param rsiData - Datos actuales del RSI
 * @returns true si debe enviar alerta
 */
function shouldSendAlert(userConfig: UserConfig, rsiData: RSIData): boolean {
  if (!userConfig.alertsEnabled) return false;
  
  const now = Date.now();
  const timeSinceLastAlert = now - userConfig.lastAlertTime;
  
  // Verificar cooldown
  if (timeSinceLastAlert < ALERT_COOLDOWN) return false;
  
  // Verificar umbrales
  const isOversold = rsiData.value <= userConfig.rsiThresholds.oversold;
  const isOverbought = rsiData.value >= userConfig.rsiThresholds.overbought;
  
  return isOversold || isOverbought;
}

/**
 * Envía alerta de RSI al usuario y a sus canales configurados
 * @param chatId - ID del chat de Telegram
 * @param rsiData - Datos del RSI
 * @param userConfig - Configuración del usuario
 */
async function sendRSIAlert(chatId: number, rsiData: RSIData, userConfig: UserConfig): Promise<void> {
  const isOversold = rsiData.value <= userConfig.rsiThresholds.oversold;
  const alertType = isOversold ? '🟢 SOBREVENTA' : '🔴 SOBRECOMPRA';
  const emoji = isOversold ? '📈' : '📉';
  
  const message = `
${emoji} *ALERTA RSI BTC/USDT* ${emoji}

🔸 *Tipo:* ${alertType}
🔸 *RSI Actual:* ${rsiData.value}
🔸 *Precio:* ${rsiData.price.toLocaleString()}
🔸 *Hora:* ${new Date(rsiData.timestamp).toLocaleString()}
🔸 *Timeframe:* 5 minutos

${isOversold ? '💡 El RSI indica posible zona de compra' : '⚠️ El RSI indica posible zona de venta'}

_Bot RSI BTC/USDT - Timeframe 5m_
  `.trim();

  try {
    // Enviar al chat privado del usuario
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    
    // Enviar a todos los canales configurados
    for (const channel of userConfig.channels) {
      try {
        await bot.sendMessage(channel, message, { parse_mode: 'Markdown' });
        console.log(`✅ Alerta enviada al canal: ${channel}`);
      } catch (channelError) {
        console.error(`❌ Error enviando a canal ${channel}:`, channelError);
        // Notificar al usuario sobre el error del canal
        await bot.sendMessage(chatId, `⚠️ No se pudo enviar alerta al canal ${channel}. Verifica que el bot sea administrador.`);
      }
    }
    
    userConfigs.get(chatId)!.lastAlertTime = Date.now();
  } catch (error) {
    console.error(`Error enviando mensaje a ${chatId}:`, error);
  }
}

/**
 * Loop principal de monitoreo del RSI
 */
async function monitorRSI(): Promise<void> {
  try {
    // Obtener RSI actual
    const rsiData = await getCurrentRSI();
    lastRSIValue = rsiData;
    
    console.log(`📊 RSI actual: ${rsiData.value} | Precio: $${rsiData.price.toLocaleString()}`);
    
    // Verificar alertas para todos los usuarios
    for (const [chatId, userConfig] of userConfigs.entries()) {
      if (shouldSendAlert(userConfig, rsiData)) {
        console.log(`🚨 Enviando alerta a usuario ${chatId}`);
        await sendRSIAlert(chatId, rsiData, userConfig);
      }
    }
    
  } catch (error) {
    console.error('❌ Error en monitoreo RSI:', error);
  }
  
  // Programar siguiente verificación
  setTimeout(monitorRSI, CHECK_INTERVAL);
}

// Comandos del bot
bot.onText(/\/start/, async (msg) => {
  console.log('📨 Comando /start recibido');
  console.log('👤 Usuario:', msg.from?.username || msg.from?.first_name);
  console.log('💬 Chat ID:', msg.chat.id);
  
  const chatId = msg.chat.id;
  
  // Inicializar configuración del usuario
  userConfigs.set(chatId, {
    chatId,
    rsiThresholds: {
      oversold: 30,  // RSI <= 30 (sobreventa)
      overbought: 70 // RSI >= 70 (sobrecompra)
    },
    alertsEnabled: true,
    lastAlertTime: 0,
    channels: [] // Sin canales por defecto
  });
  
  console.log('✅ Usuario configurado correctamente');
  
  const welcomeMessage = `
🤖 *Bot de Alertas RSI BTC/USDT*

¡Bienvenido! Este bot te enviará alertas cuando el RSI de BTC/USDT alcance niveles importantes.

📊 *Configuración inicial:*
• RSI Sobreventa: ≤ 30
• RSI Sobrecompra: ≥ 70
• Alertas: Activadas

📝 *Comandos disponibles:*
/set_oversold <valor> - Configurar umbral de sobreventa
/set_overbought <valor> - Configurar umbral de sobrecompra
/add_channel @canal - Añadir canal público para alertas
/add_channel -1001234567890 - Añadir canal privado (Chat ID)
/remove_channel @canal - Quitar canal de alertas
/remove_channel -1001234567890 - Quitar canal usando Chat ID
/list_channels - Ver canales configurados
/status - Ver configuración y RSI actual
/toggle - Activar/desactivar alertas
/help - Mostrar ayuda

🔄 El bot verifica el RSI cada 10 segundos (velas de 5min).
  `.trim();
  
  try {
    await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
    console.log('✅ Mensaje de bienvenida enviado');
  } catch (error) {
    console.error('❌ Error enviando mensaje de bienvenida:', error);
  }
});

bot.onText(/\/set_oversold (\d+)/, async (msg, match) => {
  console.log('📨 Comando /set_oversold recibido');
  const chatId = msg.chat.id;
  const value = parseInt(match![1]);
  
  if (value < 1 || value > 99) {
    await bot.sendMessage(chatId, '❌ El valor debe estar entre 1 y 99');
    return;
  }
  
  const userConfig = userConfigs.get(chatId);
  if (userConfig) {
    userConfig.rsiThresholds.oversold = value;
    await bot.sendMessage(chatId, `✅ Umbral de sobreventa configurado a ${value}`);
    console.log(`✅ Usuario ${chatId} configuró sobreventa a ${value}`);
  } else {
    await bot.sendMessage(chatId, '❌ Primero usa /start para inicializar el bot');
  }
});

bot.onText(/\/set_overbought (\d+)/, async (msg, match) => {
  console.log('📨 Comando /set_overbought recibido');
  const chatId = msg.chat.id;
  const value = parseInt(match![1]);
  
  if (value < 1 || value > 99) {
    await bot.sendMessage(chatId, '❌ El valor debe estar entre 1 y 99');
    return;
  }
  
  const userConfig = userConfigs.get(chatId);
  if (userConfig) {
    userConfig.rsiThresholds.overbought = value;
    await bot.sendMessage(chatId, `✅ Umbral de sobrecompra configurado a ${value}`);
    console.log(`✅ Usuario ${chatId} configuró sobrecompra a ${value}`);
  } else {
    await bot.sendMessage(chatId, '❌ Primero usa /start para inicializar el bot');
  }
});

// COMANDO ACTUALIZADO - Acepta tanto @username como Chat ID
bot.onText(/\/add_channel (.+)/, async (msg, match) => {
  console.log('📨 Comando /add_channel recibido');
  const chatId = msg.chat.id;
  const channelInput = match![1].trim();
  
  const userConfig = userConfigs.get(chatId);
  if (!userConfig) {
    await bot.sendMessage(chatId, '❌ Primero usa /start para inicializar el bot');
    return;
  }
  
  // Validar formato: debe ser @username o -100xxxxxxxxxx
  const isUsername = channelInput.match(/^@\w+$/);
  const isChatId = channelInput.match(/^-100\d{10}$/);
  
  if (!isUsername && !isChatId) {
    await bot.sendMessage(chatId, '❌ Formato inválido. Usa:\n• @nombre_canal (para canales públicos)\n• -1001234567890 (Chat ID para canales privados)');
    return;
  }
  
  // Verificar si el canal ya está añadido
  if (userConfig.channels.includes(channelInput)) {
    await bot.sendMessage(chatId, `❌ El canal ${channelInput} ya está en la lista`);
    return;
  }
  
  // Verificar si el bot puede enviar mensajes al canal
  try {
    const testMessage = isUsername 
      ? `🤖 Bot RSI añadido correctamente al canal ${channelInput}. Las alertas se enviarán aquí.`
      : '🤖 Bot RSI añadido correctamente. Las alertas se enviarán aquí.';
      
    await bot.sendMessage(channelInput, testMessage);
    userConfig.channels.push(channelInput);
    
    const successMessage = isUsername
      ? `✅ Canal ${channelInput} añadido correctamente`
      : `✅ Canal añadido correctamente (ID: ${channelInput})`;
      
    await bot.sendMessage(chatId, successMessage);
    console.log(`✅ Canal ${channelInput} añadido para usuario ${chatId}`);
  } catch (error) {
    console.error(`❌ Error añadiendo canal ${channelInput}:`, error);
    
    const errorMessage = isUsername
      ? `❌ No se pudo añadir ${channelInput}. Verifica que:\n• El canal existe\n• El bot es administrador del canal\n• El nombre del canal es correcto`
      : `❌ No se pudo añadir el canal. Verifica que:\n• El Chat ID es correcto\n• El bot es administrador del canal\n• El canal existe`;
      
    await bot.sendMessage(chatId, errorMessage);
  }
});

// COMANDO ACTUALIZADO - Acepta tanto @username como Chat ID
bot.onText(/\/remove_channel (.+)/, async (msg, match) => {
  console.log('📨 Comando /remove_channel recibido');
  const chatId = msg.chat.id;
  const channelInput = match![1].trim();
  
  const userConfig = userConfigs.get(chatId);
  if (!userConfig) {
    await bot.sendMessage(chatId, '❌ Primero usa /start para inicializar el bot');
    return;
  }
  
  const channelIndex = userConfig.channels.indexOf(channelInput);
  if (channelIndex === -1) {
    await bot.sendMessage(chatId, `❌ El canal ${channelInput} no está en la lista`);
    return;
  }
  
  userConfig.channels.splice(channelIndex, 1);
  await bot.sendMessage(chatId, `✅ Canal ${channelInput} eliminado de la lista`);
  console.log(`✅ Canal ${channelInput} eliminado para usuario ${chatId}`);
});

bot.onText(/\/list_channels/, async (msg) => {
  console.log('📨 Comando /list_channels recibido');
  const chatId = msg.chat.id;
  const userConfig = userConfigs.get(chatId);
  
  if (!userConfig) {
    await bot.sendMessage(chatId, '❌ Primero usa /start para inicializar el bot');
    return;
  }
  
  if (userConfig.channels.length === 0) {
    await bot.sendMessage(chatId, '📝 No tienes canales configurados.\n\nUsa:\n/add_channel @tu_canal (público)\n/add_channel -1001234567890 (privado)');
    return;
  }
  
  const channelsList = userConfig.channels.map(ch => `• ${ch}`).join('\n');
  await bot.sendMessage(chatId, `📝 *Canales configurados:*\n\n${channelsList}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/status/, async (msg) => {
  console.log('📨 Comando /status recibido');
  const chatId = msg.chat.id;
  const userConfig = userConfigs.get(chatId);
  
  if (!userConfig) {
    await bot.sendMessage(chatId, '❌ Primero usa /start para inicializar el bot');
    return;
  }
  
  const currentRSI = lastRSIValue;
  const channelsText = userConfig.channels.length > 0 
    ? userConfig.channels.join(', ')
    : 'Ninguno';
    
  const statusMessage = `
📊 *Estado del Bot RSI BTC/USDT*

🔧 *Tu configuración:*
• Sobreventa: ≤ ${userConfig.rsiThresholds.oversold}
• Sobrecompra: ≥ ${userConfig.rsiThresholds.overbought}
• Alertas: ${userConfig.alertsEnabled ? '✅ Activadas' : '❌ Desactivadas'}
• Canales: ${channelsText}

📈 *RSI Actual:* ${currentRSI ? `${currentRSI.value} (Precio: ${currentRSI.price.toLocaleString()})` : 'Calculando...'}
🕐 *Última actualización:* ${currentRSI ? new Date(currentRSI.timestamp).toLocaleString() : 'N/A'}
⏱️ *Timeframe:* 5 minutos

⏱️ *Próxima verificación:* 10 segundos
  `.trim();
  
  await bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/toggle/, async (msg) => {
  console.log('📨 Comando /toggle recibido');
  const chatId = msg.chat.id;
  const userConfig = userConfigs.get(chatId);
  
  if (!userConfig) {
    await bot.sendMessage(chatId, '❌ Primero usa /start para inicializar el bot');
    return;
  }
  
  userConfig.alertsEnabled = !userConfig.alertsEnabled;
  const status = userConfig.alertsEnabled ? 'activadas' : 'desactivadas';
  const emoji = userConfig.alertsEnabled ? '✅' : '❌';
  
  await bot.sendMessage(chatId, `${emoji} Alertas ${status}`);
  console.log(`✅ Usuario ${chatId} ${status} las alertas`);
});

bot.onText(/\/help/, async (msg) => {
  console.log('📨 Comando /help recibido');
  const chatId = msg.chat.id;

  const helpMessage = `
📖 *Ayuda - Bot RSI BTC/USDT*

🔧 *Comandos:*
\`/start\` - Inicializar bot con configuración por defecto
\`/set_oversold\` <valor> - Configurar umbral de sobreventa (1-99)
\`/set_overbought\` <valor> - Configurar umbral de sobrecompra (1-99)
\`/add_channel\` @canal - Añadir canal público para alertas
\`/add_channel\` -1001234567890 - Añadir canal privado usando Chat ID
\`/remove_channel\` @canal - Quitar canal de alertas
\`/remove_channel\` -1001234567890 - Quitar canal usando Chat ID
\`/list_channels\` - Ver canales configurados
\`/status\` - Ver configuración actual y RSI actual
\`/toggle\` - Activar/desactivar alertas
\`/help\` - Mostrar esta ayuda

📊 *Sobre el RSI:*
• RSI = Relative Strength Index (0-100)
• < 30: Zona de sobreventa (posible compra)
• > 70: Zona de sobrecompra (posible venta)
• Se calcula con velas de 5 minutos

⚙️ *Configuración:*
• Verificación cada 10 segundos
• Cooldown de 5 minutos entre alertas
• Basado en datos de Binance API

💡 *Ejemplo de uso:*
\`/set_oversold 25\` (alerta cuando RSI ≤ 25)
\`/set_overbought 75\` (alerta cuando RSI ≥ 75)
\`/add_channel @mi_canal\` (canal público)
\`/add_channel -1001234567890\` (canal privado)
  `.trim();

  await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// Manejo de errores
bot.on('polling_error', (error) => {
  console.error('❌ Error de polling:', error.message);
});

// Agregar listener para todos los mensajes (debugging)
bot.on('message', (msg) => {
  console.log('📩 Mensaje recibido:', {
    from: msg.from?.username || msg.from?.first_name,
    chat_id: msg.chat.id,
    text: msg.text,
    date: new Date(msg.date * 1000).toLocaleString()
  });
});

process.on('uncaughtException', (error) => {
  console.error('❌ Error no capturado:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promesa rechazada no manejada:', reason);
});

// Inicializar el bot
console.log('🚀 Iniciando bot de alertas RSI BTC/USDT...');
console.log('📊 Configuración:');
console.log(`   • Período RSI: ${RSI_PERIOD}`);
console.log(`   • Intervalo de verificación: ${CHECK_INTERVAL / 1000}s`);
console.log(`   • Cooldown entre alertas: ${ALERT_COOLDOWN / 1000}s`);
console.log(`   • Token configurado: ${TELEGRAM_TOKEN !== 'TU_TOKEN_AQUI' ? '✅ Sí' : '❌ No'}`);

// Iniciar monitoreo después de un pequeño delay para permitir que el bot se conecte
setTimeout(() => {
  console.log('🔄 Iniciando monitoreo RSI...');
  monitorRSI();
}, 2000);

console.log('✅ Bot iniciado correctamente. Esperando comandos...');