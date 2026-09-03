const WebSocket = require('ws');
const cron = require('node-cron');

// Bot Credentials
const TELEGRAM_BOT_TOKEN = '8236438859:AAF68C1yOzZoZMVShpsNRFs8BBBsruTr_14';
const TELEGRAM_CHAT_ID = '8686672394';
const PUMP_WS_URL = 'wss://pumpportal.fun/api/data';

let gotScrapingModule;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeUsername(value) {
  if (value === null || value === undefined) return null;

  const str = String(value).trim();
  if (!str || str === 'N/A' || str === 'null' || str === 'undefined') return null;

  const cleaned = str.replace(/\s+/g, ' ');
  
  if (cleaned.length < 2 || cleaned.length > 50) {
    return null;
  }

  return cleaned;
}

// Retries fetch with a delay to account for Pump.fun backend indexing
async function getPumpUsername(mint, walletAddress, retries = 3) {
  if (!gotScrapingModule) {
    gotScrapingModule = (await import('got-scraping')).gotScraping;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // 1. Check User Profile Endpoint
      const userRes = await gotScrapingModule({
        url: `https://frontend-api-v3.pump.fun/users/${walletAddress}`,
        responseType: 'json',
        headers: {
          'accept': 'application/json',
          'origin': 'https://pump.fun',
          'referer': 'https://pump.fun/'
        },
        timeout: { request: 3000 }
      });

      const userUsername = normalizeUsername(userRes?.body?.username || userRes?.body?.user?.username);
      if (userUsername) {
        return userUsername;
      }

      // 2. Check Coin Metadata Endpoint
      const coinRes = await gotScrapingModule({
        url: `https://frontend-api-v3.pump.fun/coins/${mint}`,
        responseType: 'json',
        headers: {
          'accept': 'application/json',
          'origin': 'https://pump.fun',
          'referer': 'https://pump.fun/'
        },
        timeout: { request: 3000 }
      });

      const coinUsername = normalizeUsername(
        coinRes?.body?.username ||
        coinRes?.body?.user?.username ||
        coinRes?.body?.creator?.username ||
        coinRes?.body?.creator?.displayName
      );

      if (coinUsername) {
        return coinUsername;
      }
    } catch (err) {
      // Ignore temporary errors during indexing
    }

    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  return null;
}

async function sendTelegramMessage(text) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Telegram API Error:', errorText);
    }
  } catch (err) {
    console.error('Failed to send Telegram message:', err.message);
  }
}

function startListener() {
  const ws = new WebSocket(PUMP_WS_URL);

  ws.on('open', () => {
    console.log('Connected! Listening for new tokens created by devs containing "dev" AND "sol"...');
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });

  ws.on('message', async (data) => {
    try {
      const token = JSON.parse(data);

      if (token.signature && token.traderPublicKey) {
        const devUsername = await getPumpUsername(token.mint, token.traderPublicKey);

        // FILTER 1: Skip if dev username is missing or invalid
        if (!devUsername) {
          return;
        }

        // FILTER 2: Must contain BOTH "dev" AND "sol" (case-insensitive)
        const lowerName = devUsername.toLowerCase();
        const hasDev = lowerName.includes('dev');
        const hasSol = lowerName.includes('sol');

        if (!hasDev || !hasSol) {
          return;
        }

        const message = 
          `🎯 <b>Target Dev Match Found!</b>\n\n` +
          `• <b>Name:</b> ${escapeHtml(token.name || 'N/A')} ($${escapeHtml(token.symbol || 'N/A')})\n` +
          `• <b>Contract:</b> <code>${token.mint}</code>\n` +
          `• <b>Dev Username:</b> <b>${escapeHtml(devUsername)}</b>\n` +
          `• <b>Dev Wallet:</b> <code>${token.traderPublicKey}</code>\n` +
          `• <b>Dev Buy Amount:</b> ${token.solAmount ? token.solAmount + ' SOL' : '0 SOL'}\n\n` +
          `<a href="https://pump.fun/${token.mint}">View Token on Pump.fun</a>`;

        await sendTelegramMessage(message);
      }
    } catch (err) {
      console.error('Error processing token:', err.message);
    }
  });

  ws.on('close', () => {
    console.log('Connection lost. Reconnecting in 3 seconds...');
    setTimeout(startListener, 3000);
  });

  ws.on('error', (err) => console.error('WebSocket Error:', err.message));
}

// 🟢 Daily Heartbeat: Runs every day at 6:00 PM (18:00) local time
cron.schedule('0 18 * * *', async () => {
  console.log('Sending daily 6 PM heartbeat notification...');
  const heartbeatMsg = 
    `🟢 <b>Bot Status Update</b>\n\n` +
    `Bot is currently online, active, and monitoring Pump.fun tokens for devs with <b>dev</b> + <b>sol</b> in their username.`;
  
  await sendTelegramMessage(heartbeatMsg);
});

startListener();