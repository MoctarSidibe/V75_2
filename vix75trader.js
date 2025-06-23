const WebSocket = require('ws');
const fs = require('fs');

const API_TOKEN = process.env.DERIV_API_TOKEN;
const APP_ID = process.env.DERIV_APP_ID;
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

if (!API_TOKEN || !APP_ID) {
  const error = new Error('Missing required environment variables: DERIV_API_TOKEN or DERIV_APP_ID');
  console.error(error.message);
  fs.appendFileSync('error.log', `${new Date().toISOString()} - ${error.message}\n`);
  process.exit(1);
}

let ws;
let candles = [];
let currentCandle = null;
let lastTradeTime = 0;
const TRADE_COOLDOWN = 300; // 5 minutes in seconds
let requestId = 1;
let actualBalance = 0;
let simulatedBalance = 100; // Simulate $100 starting balance
let highestSimulatedBalance = 100; // Track highest simulated balance
let isSubscribed = false;

function connectWebSocket() {
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('Connected to Deriv WebSocket');
    fs.appendFileSync('debug.log', `${new Date().toISOString()} - Connected to Deriv WebSocket\n`);
    sendRequest({ authorize: API_TOKEN });
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      console.log('Received message:', JSON.stringify(msg));
      fs.appendFileSync('debug.log', `${new Date().toISOString()} - Received message: ${JSON.stringify(msg)}\n`);
      handleWebSocketMessage(msg);
    } catch (error) {
      console.error('Message parse error:', error.message);
      fs.appendFileSync('error.log', `${new Date().toISOString()} - Message parse error: ${error.message}\n`);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
    fs.appendFileSync('error.log', `${new Date().toISOString()} - WebSocket error: ${error.message}\n`);
  });

  ws.on('close', () => {
    console.log('WebSocket closed. Reconnecting...');
    fs.appendFileSync('error.log', `${new Date().toISOString()} - WebSocket closed. Reconnecting...\n`);
    setTimeout(connectWebSocket, 1000);
  });
}

function sendRequest(request) {
  if (ws.readyState !== WebSocket.OPEN) {
    const error = new Error(`WebSocket not open: readyState ${ws.readyState}`);
    console.error(error.message);
    fs.appendFileSync('error.log', `${new Date().toISOString()} - ${error.message}\n`);
    return;
  }
  request.req_id = requestId++;
  console.log('Sending request:', JSON.stringify(request));
  fs.appendFileSync('debug.log', `${new Date().toISOString()} - Sending request: ${JSON.stringify(request)}\n`);
  ws.send(JSON.stringify(request));
  return request.req_id;
}

function handleWebSocketMessage(msg) {
  if (msg.error) {
    console.error('API error:', msg.error.message);
    fs.appendFileSync('error.log', `${new Date().toISOString()} - API error: ${msg.error.message}\n`);
    return;
  }

  if (msg.authorize) {
    console.log('Authenticated successfully:', msg.authorize.loginid);
    fs.appendFileSync('debug.log', `${new Date().toISOString()} - Authenticated successfully: ${msg.authorize.loginid}\n`);
    sendRequest({ balance: 1 });
  } else if (msg.balance) {
    actualBalance = msg.balance.balance;
    console.log(`Actual Balance: ${actualBalance}, Simulated Balance: ${simulatedBalance}`);
    fs.appendFileSync('balance.log', `${new Date().toISOString()} - Actual Balance: ${actualBalance}, Simulated Balance: ${simulatedBalance}\n`);
    if (!isSubscribed) {
      if (actualBalance < 1) {
        console.error('Insufficient actual balance for trading:', actualBalance);
        fs.appendFileSync('error.log', `${new Date().toISOString()} - Insufficient actual balance for trading: ${actualBalance}\n`);
        return;
      }
      isSubscribed = true;
      subscribeToOHLC();
    }
  } else if (msg.candles) {
    candles = msg.candles.map(candle => ({
      open: parseFloat(candle.open),
      high: parseFloat(candle.high),
      low: parseFloat(candle.low),
      close: parseFloat(candle.close),
      open_time: parseInt(candle.epoch),
      epoch: parseInt(candle.epoch),
    }));
    console.log('Loaded', candles.length, 'historical candles');
    fs.appendFileSync('debug.log', `${new Date().toISOString()} - Loaded ${candles.length} historical candles\n`);
    checkStrategy();
  } else if (msg.ohlc) {
    const ohlc = msg.ohlc;
    if (!ohlc.epoch || !ohlc.open || !ohlc.high || !ohlc.low || !ohlc.close || !ohlc.open_time) {
      console.error('Invalid ohlc data:', ohlc);
      fs.appendFileSync('error.log', `${new Date().toISOString()} - Invalid ohlc data: ${JSON.stringify(ohlc)}\n`);
      return;
    }

    const newOpenTime = parseInt(ohlc.open_time);
    const candle = {
      open: parseFloat(ohlc.open),
      high: parseFloat(ohlc.high),
      low: parseFloat(ohlc.low),
      close: parseFloat(ohlc.close),
      open_time: newOpenTime,
      epoch: parseInt(ohlc.epoch),
    };

    console.log('Processing ohlc:', candle);
    fs.appendFileSync('debug.log', `${new Date().toISOString()} - Processing ohlc: ${JSON.stringify(candle)}\n`);

    if (!currentCandle) {
      currentCandle = candle;
      console.log('Started new candle:', currentCandle);
      fs.appendFileSync('debug.log', `${new Date().toISOString()} - Started new candle: ${JSON.stringify(currentCandle)}\n`);
    } else if (newOpenTime !== currentCandle.open_time) {
      candles.push(currentCandle);
      console.log('Finalized candle:', currentCandle);
      fs.appendFileSync('debug.log', `${new Date().toISOString()} - Finalized candle: ${JSON.stringify(currentCandle)}\n`);
      if (candles.length > 200) candles.shift();
      currentCandle = candle;
      console.log('Started new candle:', currentCandle);
      fs.appendFileSync('debug.log', `${new Date().toISOString()} - Started new candle: ${JSON.stringify(currentCandle)}\n`);
      checkStrategy();
    } else {
      currentCandle.high = Math.max(currentCandle.high, candle.high);
      currentCandle.low = Math.min(currentCandle.low, candle.low);
      currentCandle.close = candle.close;
      currentCandle.epoch = candle.epoch;
      console.log('Updated current candle:', currentCandle);
      fs.appendFileSync('debug.log', `${new Date().toISOString()} - Updated current candle: ${JSON.stringify(currentCandle)}\n`);
    }
  } else if (msg.proposal) {
    const buyParams = {
      buy: msg.proposal.id,
      price: 1, // Fixed $1 stake
    };
    console.log('Placing trade:', buyParams);
    fs.appendFileSync('trades.log', `${new Date().toISOString()} - Placing trade: ${JSON.stringify(buyParams)}\n`);
    sendRequest(buyParams);
  } else if (msg.buy) {
    console.log('Trade placed successfully:', msg.buy);
    fs.appendFileSync('trades.log', `${new Date().toISOString()} - Trade placed: ${JSON.stringify(msg.buy)}\n`);
    // Update simulated balance based on trade outcome
    const stake = 1; // Fixed $1 stake
    const payout = msg.buy.payout ? parseFloat(msg.buy.payout) : 0;
    if (payout > 0) {
      simulatedBalance += (payout - stake); // Add profit
    } else {
      simulatedBalance -= stake; // Deduct loss
    }
    if (simulatedBalance > highestSimulatedBalance) {
      highestSimulatedBalance = simulatedBalance;
    }
    console.log(`Trade outcome - Simulated Balance: ${simulatedBalance}`);
    fs.appendFileSync('balance.log', `${new Date().toISOString()} - Trade outcome - Simulated Balance: ${simulatedBalance}\n`);
    lastTradeTime = Date.now() / 1000;
    sendRequest({ balance: 1 }); // Update actual balance
  }
}

function subscribeToOHLC() {
  console.log('Subscribing to 1-minute candles for R_75');
  fs.appendFileSync('debug.log', `${new Date().toISOString()} - Subscribing to 1-minute candles for R_75\n`);
  sendRequest({
    ticks_history: 'R_75',
    adjust_start_time: 1,
    count: 100,
    end: 'latest',
    start: 1,
    style: 'candles',
    granularity: 60,
    subscribe: 1,
  });
}

function priceActionStrategy() {
  console.log('Checking strategy with', candles.length, 'candles');
  fs.appendFileSync('debug.log', `${new Date().toISOString()} - Checking strategy with ${candles.length} candles\n`);

  if (candles.length < 2) {
    console.log('Not enough candles to check engulfing. Current count:', candles.length);
    fs.appendFileSync('debug.log', `${new Date().toISOString()} - Not enough candles to check engulfing. Current count: ${candles.length}\n`);
    return null;
  }

  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];

  console.log('Checking engulfing with candles:', {
    prev: { open: prevCandle.open, close: prevCandle.close },
    last: { open: lastCandle.open, close: lastCandle.close },
  });
  fs.appendFileSync('debug.log', `${new Date().toISOString()} - Checking engulfing with candles: ${JSON.stringify({
    prev: { open: prevCandle.open, close: prevCandle.close },
    last: { open: lastCandle.open, close: lastCandle.close },
  })}\n`);

  const isPrevBearish = prevCandle.open > prevCandle.close;
  const isLastBullish = lastCandle.close > lastCandle.open;
  const isBullishEngulfing = isPrevBearish && isLastBullish && lastCandle.close > prevCandle.open && lastCandle.open < prevCandle.close;

  const isPrevBullish = prevCandle.close > prevCandle.open;
  const isLastBearish = lastCandle.open > lastCandle.close;
  const isBearishEngulfing = isPrevBullish && isLastBearish && lastCandle.open > prevCandle.close && lastCandle.close < prevCandle.open;

  console.log('Engulfing conditions:', {
    isPrevBearish,
    isLastBullish,
    isBullishEngulfing,
    isPrevBullish,
    isLastBearish,
    isBearishEngulfing,
  });
  fs.appendFileSync('debug.log', `${new Date().toISOString()} - Engulfing conditions: ${JSON.stringify({
    isPrevBearish,
    isLastBullish,
    isBullishEngulfing,
    isPrevBullish,
    isLastBearish,
    isBearishEngulfing,
  })}\n`);

  if (isBullishEngulfing) {
    console.log('Bullish engulfing detected');
    fs.appendFileSync('debug.log', `${new Date().toISOString()} - Bullish engulfing detected\n`);
    return 'call';
  } else if (isBearishEngulfing) {
    console.log('Bearish engulfing detected');
    fs.appendFileSync('debug.log', `${new Date().toISOString()} - Bearish engulfing detected\n`);
    return 'put';
  } else {
    console.log('No engulfing pattern detected');
    fs.appendFileSync('debug.log', `${new Date().toISOString()} - No engulfing pattern detected\n`);
    return null;
  }
}

function placeTrade(decision) {
  const tradeParams = {
    proposal: 1,
    symbol: 'R_75',
    contract_type: decision.toUpperCase(),
    amount: 1, // Fixed $1 stake
    basis: 'stake',
    currency: 'USD',
    duration: 5,
    duration_unit: 't',
  };

  console.log('Requesting trade proposal:', tradeParams);
  fs.appendFileSync('debug.log', `${new Date().toISOString()} - Requesting trade proposal: ${JSON.stringify(tradeParams)}\n`);
  sendRequest(tradeParams);
}

function checkStrategy() {
  if (Date.now() / 1000 - lastTradeTime < TRADE_COOLDOWN) {
    console.log('Trade skipped: Within 5-minute cooldown');
    fs.appendFileSync('debug.log', `${new Date().toISOString()} - Trade skipped: Within 5-minute cooldown\n`);
    return;
  }

  if (simulatedBalance < 1) {
    console.log('Insufficient simulated balance for trading:', simulatedBalance);
    fs.appendFileSync('error.log', `${new Date().toISOString()} - Insufficient simulated balance for trading: ${simulatedBalance}\n`);
    return;
  }

  if (actualBalance < 1) {
    console.log('Insufficient actual balance for trading:', actualBalance);
    fs.appendFileSync('error.log', `${new Date().toISOString()} - Insufficient actual balance for trading: ${actualBalance}\n`);
    return;
  }

  const drawdownThreshold = 0.1; // 10%
  if (simulatedBalance < highestSimulatedBalance * (1 - drawdownThreshold)) {
    console.log('Trade skipped: Simulated drawdown exceeded');
    fs.appendFileSync('debug.log', `${new Date().toISOString()} - Trade skipped: Simulated drawdown exceeded\n`);
    return;
  }

  const decision = priceActionStrategy();
  if (decision) {
    placeTrade(decision);
  }
}

connectWebSocket();