const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const socketIo = require('socket.io');
const http = require('http');
const fs = require('fs');
const ExcelJS = require('exceljs');
const cors = require('cors');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const macaddress = require('macaddress');
const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { ChatPromptTemplate } = require('@langchain/core/prompts');

process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'true';
const CUSTOM_SALT = 'a7b9c2d4e6f8g0h1i3j5k7l9m2n4o6p8q0r2s4t6u8v0w2x4y6z8';
const SECRET_KEY = 'x9k2m5p8r1t4w7z0b3e6h9j2n5q8u1y4';
const rateLimits = new Map();

function detectChromePath() {
    const possiblePaths = [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`
    ];
    for (const chromePath of possiblePaths) {
        if (fs.existsSync(chromePath)) return chromePath;
    }
    console.warn('Chrome not found, attempting to proceed without specific path');
    return 'chrome';
}

function deriveKey(salt) {
    return crypto.pbkdf2Sync(SECRET_KEY, salt, 100000, 32, 'sha256');
}

function obfuscate(text) {
    const iv = crypto.randomBytes(16);
    const key = deriveKey(CUSTOM_SALT);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function deobfuscate(encryptedText) {
    try {
        const [ivHex, encrypted] = encryptedText.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const key = deriveKey(CUSTOM_SALT);
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (error) {
        console.error('Decryption error:', error);
        return null;
    }
}

function applyRateLimit(key, maxRequests = 50, windowMs = 60 * 60 * 1000) {
    const now = Date.now();
    const record = rateLimits.get(key) || { count: 0, start: now };
    if (now - record.start > windowMs) {
        record.count = 0;
        record.start = now;
    }
    if (record.count >= maxRequests) return false;
    record.count += 1;
    rateLimits.set(key, record);
    return true;
}

const baseDir = app.isPackaged ? path.dirname(process.execPath) : __dirname;
const envPath = path.join(baseDir, '.env');
const uploadDir = path.join(baseDir, 'uploads');
const authDir = path.join(baseDir, 'whatsapp-auth');

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadEnv() {
    ensureDir(baseDir);
    if (fs.existsSync(envPath)) {
        const encryptedContent = fs.readFileSync(envPath, 'utf8').trim();
        if (encryptedContent) {
            const decryptedContent = deobfuscate(encryptedContent);
            if (decryptedContent) {
                decryptedContent.split('\n').forEach(line => {
                    const [key, value] = line.split('=');
                    if (key && value) process.env[key.trim()] = value.trim();
                });
            }
        }
    }
}

function saveEnv(content) {
    ensureDir(baseDir);
    const encryptedContent = obfuscate(content);
    fs.writeFileSync(envPath, encryptedContent, 'utf8');
}

loadEnv();
process.env.PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || detectChromePath();

const expressApp = express();
const server = http.createServer(expressApp);
const io = socketIo(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

ensureDir(uploadDir);
const upload = multer({ dest: uploadDir });

expressApp.use(express.json());
expressApp.use(cors());

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: authDir }),
    puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-extensions']
    }
});

let qrCodeData = '';
let isAuthenticated = false;
let messages = [];
let polls = {};
let pollVotes = {};
let sendingStatus = { paused: false };
let geminiPrompts = [
    'Create a fun poll question for a college fest',
    'How can we make our college fest more exciting?',
    'Suggest a customer feedback question for a fest event'
];

const usersFilePath = path.join(baseDir, 'users.json');
let users = new Map();
let sessions = new Map();

function saveUsers() {
    ensureDir(baseDir);
    const usersObject = Object.fromEntries(users);
    const data = JSON.stringify(usersObject);
    const encryptedData = obfuscate(data);
    const hmac = crypto.createHmac('sha256', CUSTOM_SALT).update(data).digest('hex');
    fs.writeFileSync(usersFilePath, JSON.stringify({ data: encryptedData, hmac }), 'utf8');
}

function loadUsers() {
    if (fs.existsSync(usersFilePath)) {
        const fileContent = fs.readFileSync(usersFilePath, 'utf8');
        const { data: encryptedData, hmac } = JSON.parse(fileContent);
        const decryptedData = deobfuscate(encryptedData);
        if (!decryptedData) return;
        const computedHmac = crypto.createHmac('sha256', CUSTOM_SALT).update(decryptedData).digest('hex');
        if (hmac !== computedHmac) {
            console.log('Users file tampered with! Resetting...');
            users = new Map();
            if (fs.existsSync(usersFilePath)) fs.unlinkSync(usersFilePath);
            return;
        }
        users = new Map(Object.entries(JSON.parse(decryptedData)));
    }
}

function getDeviceId() {
    const deviceIdPath = path.join(uploadDir, 'device_id.txt');
    if (fs.existsSync(deviceIdPath)) return fs.readFileSync(deviceIdPath, 'utf8');
    const newDeviceId = uuidv4();
    fs.writeFileSync(deviceIdPath, newDeviceId, 'utf8');
    return newDeviceId;
}

function updateEnvFile(mac, key, value) {
    let envContent = fs.existsSync(envPath) ? deobfuscate(fs.readFileSync(envPath, 'utf8')) || '' : '';
    const envKey = `${key}_${mac.replace(/:/g, '_')}`;
    const envLine = `${envKey}=${value}`;
    const lines = envContent.split('\n').filter(line => line && !line.startsWith(`${envKey}=`));
    lines.push(envLine);
    saveEnv(lines.join('\n') + '\n');
    process.env[envKey] = value;
}

loadUsers();

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || 'https://discord.com/api/webhooks/1349991240481116180/ThEnDPVlnJvv5N36sF9DMT2Cl37NxyDFRLGuHs337XPIRILCH5m9_hRUmhQLOXU4nwkI';
const TIMEZONEDB_API_KEY = process.env.TIMEZONEDB_API_KEY || 'HFEF9KI8OM97';
const IPGEOLOCATION_API_KEY = process.env.IPGEOLOCATION_API_KEY || '2732312e0a95464295d01a9c507bad04';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'AIzaSyBdp-OU4LeiiFUu7uouWVhdhuBm_-9hXug';

const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
const llm = new ChatGoogleGenerativeAI({
    model: "gemini-2.0-flash",
    googleApiKey: GOOGLE_API_KEY,
    maxOutputTokens: 500,
    temperature: 0.7,
});

async function getCurrentTime() {
    const maxRetries = 3;
    const retryDelay = 1000;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.get(`https://api.timezonedb.com/v2.1/get-time-zone?key=${TIMEZONEDB_API_KEY}&format=json&by=zone&zone=Asia/Kolkata`);
            return new Date(response.data.formatted);
        } catch (error) {
            if (attempt === maxRetries) console.warn('Switching server...');
            else await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.get(`https://api.ipgeolocation.io/timezone?apiKey=${IPGEOLOCATION_API_KEY}&tz=Asia/Kolkata`);
            return new Date(response.data.date_time_txt);
        } catch (error) {
            if (attempt < maxRetries) await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }
    return new Date();
}

const marketingTemplate = `
As a expert WhatsApp marketer, create a gender-optimized message with:

Company: {companyName}
Product: {productDetails}
Target Gender: {targetGender} (female/male/unisex)
Audience: {targetAudience}
Tone: {tone}
Key Points: {keySellingPoints}
CTA: {callToAction}

Guidelines:
- Use gender-specific language for {targetGender}
- Include relevant emojis (max 3-5)
- Add gender-appropriate greeting
- Use cultural references for {targetGender}
- Maintain brand voice for {companyName}
- Include psychological triggers for {targetGender}

Structure:
[Gender-relevant greeting] [Audience-specific hook]  
[Gender-tailored benefits] 
[Gender-focused CTA] 
[Closing with urgency]

Current offer: {currentPromotion}
`;

const promptTemplate = ChatPromptTemplate.fromTemplate(marketingTemplate);

const validateMessage = (message, targetGender) => {
    const genderMarkers = {
        female: ['her', 'she', 'woman', 'ladies', 'feminine', '👩', '👜', '💄'],
        male: ['his', 'he', 'gentleman', 'men', 'masculine', '👔', '💼', '👞'],
        unisex: ['their', 'they', 'all', 'everyone', '👥', '🌟', '✨']
    };

    const checks = {
        length: message.length <= 500,
        hasGenderElements: genderMarkers[targetGender].some(el => message.toLowerCase().includes(el.toLowerCase())),
        hasToneConsistency: new RegExp(genderMarkers[targetGender].join("|"), "i").test(message),
        hasCTA: /(Shop Now|Limited|Offer|%|Discount)/i.test(message)
    };

    return checks;
};

client.on('qr', qr => {
    qrCodeData = qr;
    console.clear();
    console.log('Scan the QR code below to connect to WhatsApp:\n');
    qrcode.generate(qr, { small: true }, (qrCode) => {
        console.log(qrCode);
    });
    io.emit('qrUpdate', qr);
});

client.on('authenticated', () => {
    isAuthenticated = true;
    qrCodeData = '';
    console.clear();
    console.log('WhatsApp client authenticated successfully!');
    io.emit('authSuccess');
});

client.on('ready', async () => {
    console.log('WhatsApp client is ready');
    io.emit('connection complete');
});

client.on('disconnected', reason => {
    isAuthenticated = false;
    console.log(`WhatsApp client disconnected: ${reason}. Reconnecting...`);
    io.emit('clientDisconnected', reason);
    client.initialize();
});

client.on('message', async msg => {
    messages.unshift({
        id: msg.id._serialized,
        from: msg.from,
        body: msg.body,
        timestamp: new Date(msg.timestamp * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        type: msg.type,
        fromMe: msg.fromMe || false,
        isRead: msg.fromMe
    });

    if (msg.type === 'location') {
        const locationData = {
            phone: msg.from,
            latitude: msg.location.latitude,
            longitude: msg.location.longitude,
            timestamp: (await getCurrentTime()).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
        };
        await saveToExcel('locations.xlsx', ['phone', 'latitude', 'longitude', 'timestamp'], locationData);
    }

    if (msg.hasQuotedMsg && polls[msg._data.quotedMsgId]) {
        pollVotes[msg._data.quotedMsgId] = pollVotes[msg._data.quotedMsgId] || {};
        pollVotes[msg._data.quotedMsgId][msg.from] = msg.body;
        io.emit('pollUpdate', { pollId: msg._data.quotedMsgId, votes: pollVotes[msg._data.quotedMsgId] });
    }

    io.emit('newMessage', messages);
});

client.initialize().catch(err => {
    console.error('Client initialization error:', err);
    io.emit('clientError', { message: 'Failed to initialize WhatsApp client' });
});

async function saveToExcel(filename, headers, data) {
    const workbook = new ExcelJS.Workbook();
    const filePath = path.join(baseDir, filename);
    let worksheet;
    if (fs.existsSync(filePath)) {
        await workbook.xlsx.readFile(filePath);
        worksheet = workbook.getWorksheet(1);
    } else {
        worksheet = workbook.addWorksheet('Sheet1');
        worksheet.columns = headers.map(header => ({ header, key: header }));
    }
    worksheet.addRow(data);
    await workbook.xlsx.writeFile(filePath);
}

async function saveBulkStatus(filename, statusArray) {
    const workbook = new ExcelJS.Workbook();
    const filePath = path.join(baseDir, filename);
    const worksheet = workbook.addWorksheet('BulkSendStatus');
    worksheet.columns = [
        { header: 'Number', key: 'number' },
        { header: 'Status', key: 'status' },
        { header: 'Sent Date', key: 'sentDate' }
    ];
    statusArray.forEach(item => worksheet.addRow({
        number: item.number,
        status: item.status,
        sentDate: item.sentDate ? item.sentDate.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : ''
    }));
    await workbook.xlsx.writeFile(filePath);
}

async function loadBulkStatus(filename) {
    const workbook = new ExcelJS.Workbook();
    const filePath = path.join(baseDir, filename);
    if (!fs.existsSync(filePath)) return [];
    await workbook.xlsx.readFile(filePath);
    const worksheet = workbook.getWorksheet(1);
    const statusArray = [];
    worksheet.eachRow((row, rowNumber) => {
        if (rowNumber > 1) {
            const number = row.getCell(1).value.toString();
            const status = row.getCell(2).value;
            const sentDate = row.getCell(3).value ? new Date(row.getCell(3).value) : null;
            statusArray.push({ number, status, sentDate });
        }
    });
    return statusArray;
}

function validatePhoneNumber(number) {
    const cleaned = number.replace(/[^0-9]/g, '');
    return cleaned.length === 12 && /^\d{12}$/.test(cleaned) ? cleaned : null;
}

function validateAndFormatNumbers(numbers) {
    const seen = new Set();
    return numbers.map(validatePhoneNumber).filter(num => num && !seen.has(num) && seen.add(num));
}

async function generateGeminiResponse(prompt) {
    try {
        const result = await model.generateContent(prompt);
        return (await result.response.text()).trim();
    } catch (error) {
        console.error('Gemini response error:', error);
        return 'Error: Could not generate response';
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateOTP() {
    return crypto.randomInt(100000, 999999).toString();
}

async function sendOTPtoAdmin(identifier, otp, days) {
    try {
        await axios.post(DISCORD_WEBHOOK_URL, {
            content: `New OTP Generated\nDevice ID: ${identifier}\nOTP: ${otp}\nRequested Days: ${days}`
        });
    } catch (error) {
        console.error('Error sending OTP to admin:', error);
    }
}

async function registerUser(days) {
    if (!days || isNaN(days) || days < 1) throw new Error('Invalid number of days');

    const mac = await macaddress.one();
    const deviceId = getDeviceId();
    const identifier = `${mac}:${deviceId}`;
    const currentTime = await getCurrentTime();
    const expiresAt = new Date(currentTime);
    expiresAt.setDate(expiresAt.getDate() + parseInt(days));
    const expiresAtISO = expiresAt.toISOString();

    if (users.has(identifier)) {
        const user = users.get(identifier);
        if (user.verified) return { message: 'Device already registered and verified' };
        if (!applyRateLimit(`otp:${identifier}`)) throw new Error('Too many OTP requests');

        const otp = generateOTP();
        user.otp = otp;
        user.expiresAt = expiresAtISO;
        updateEnvFile(mac, 'EXPIRY', expiresAtISO);
        await sendOTPtoAdmin(identifier, otp, days);
        saveUsers();
        return { message: 'New OTP sent to admin for verification' };
    }

    const otp = generateOTP();
    users.set(identifier, { otp, verified: false, expiresAt: expiresAtISO, deviceId });
    updateEnvFile(mac, 'EXPIRY', expiresAtISO);
    await sendOTPtoAdmin(identifier, otp, days);
    saveUsers();
    return { message: 'OTP generated and sent to admin' };
}

async function verifyOTP(otp) {
    const mac = await macaddress.one();
    const deviceId = getDeviceId();
    const identifier = `${mac}:${deviceId}`;
    const user = users.get(identifier);

    if (!user || user.deviceId !== deviceId) throw new Error('Device not registered or tampered');
    if (user.otp === otp) {
        user.verified = true;
        const sessionToken = crypto.randomBytes(32).toString('hex');
        sessions.set(identifier, { token: sessionToken, expires: Date.now() + 24 * 60 * 60 * 1000 });
        saveUsers();
        return { message: 'OTP verified successfully', token: sessionToken };
    } else {
        users.delete(identifier);
        updateEnvFile(mac, 'EXPIRY', '');
        saveUsers();
        throw new Error('Invalid OTP. Registration terminated');
    }
}

async function checkAuth(token) {
    const mac = await macaddress.one();
    const deviceId = getDeviceId();
    const identifier = `${mac}:${deviceId}`;
    const session = sessions.get(identifier);

    if (!session || session.token !== token || Date.now() > session.expires) {
        throw new Error('Invalid or expired session');
    }

    const user = users.get(identifier);
    if (!user || user.deviceId !== deviceId || !user.verified) {
        throw new Error('Unauthorized');
    }

    const envKey = `EXPIRY_${mac.replace(/:/g, '_')}`;
    const expiryDateStr = process.env[envKey];
    if (!expiryDateStr || new Date() > new Date(expiryDateStr)) {
        users.delete(identifier);
        sessions.delete(identifier);
        updateEnvFile(mac, 'EXPIRY', '');
        saveUsers();
        throw new Error('Access expired. Please re-register');
    }
}

async function sendBulkMessages(statusArray, message, type, options, attachment, settings) {
    const { dailyLimit, batchSize, batchGap, minMessageDelay, maxMessageDelay, nonPeakStart, nonPeakEnd, variables } = settings;
    let tempFilePath = null;

    if (attachment) {
        tempFilePath = path.join(uploadDir, `${uuidv4()}-${attachment.name}`);
        fs.writeFileSync(tempFilePath, Buffer.from(attachment.data, 'base64'));
    }

    while (true) {
        const pendingNumbers = statusArray.filter(s => s.status === 'Pending');
        if (pendingNumbers.length === 0 || sendingStatus.paused) {
            io.emit(sendingStatus.paused ? 'bulkPaused' : 'bulkComplete', {
                current: statusArray.filter(s => s.status === 'Sent').length,
                total: statusArray.length
            });
            break;
        }

        const now = await getCurrentTime();
        const todayStr = now.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
        const sentToday = statusArray.filter(s => s.status === 'Sent' && s.sentDate?.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) === todayStr).length;

        if (sentToday >= dailyLimit) {
            const tomorrow = new Date(now);
            tomorrow.setDate(now.getDate() + 1);
            tomorrow.setHours(0, 0, 0, 0);
            await delay(tomorrow - now);
            continue;
        }

        const currentHour = now.getHours();
        if (currentHour >= nonPeakStart && currentHour < nonPeakEnd) {
            const endTime = new Date(now);
            endTime.setHours(nonPeakEnd, 0, 0, 0);
            await delay(endTime - now);
            continue;
        }

        const batch = pendingNumbers.slice(0, Math.min(batchSize, dailyLimit - sentToday));
        for (const item of batch) {
            if (sendingStatus.paused) break;
            let retries = 3;
            while (retries > 0) {
                try {
                    const chatId = `${item.number}@c.us`;
                    let finalMessage = message;

                    if (variables?.length) {
                        let variableIndex = 0;
                        finalMessage = message.replace(/\{([^}]+)\}/g, (match, p1) => {
                            const opts = variables[variableIndex++ % variables.length];
                            return opts[Math.floor(Math.random() * opts.length)];
                        });
                    }

                    if (type === 'poll') {
                        const pollMessage = `${finalMessage}\n${options.map((opt, j) => `${j + 1}. ${opt}`).join('\n')}`;
                        const sentMsg = await client.sendMessage(chatId, pollMessage);
                        polls[sentMsg.id._serialized] = { question: finalMessage, options };
                    } else if (attachment) {
                        const media = MessageMedia.fromFilePath(tempFilePath);
                        await client.sendMessage(chatId, media, { caption: finalMessage });
                    } else {
                        await client.sendMessage(chatId, finalMessage);
                    }
                    item.status = 'Sent';
                    item.sentDate = await getCurrentTime();
                    messages.unshift({
                        id: Date.now().toString(),
                        from: 'me',
                        body: finalMessage,
                        timestamp: item.sentDate.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
                        type: attachment ? 'media' : 'chat',
                        fromMe: true,
                        isRead: true
                    });
                    io.emit('bulkProgress', { number: item.number, status: 'Sent', current: statusArray.filter(s => s.status === 'Sent').length, total: statusArray.length });
                    break;
                } catch (error) {
                    retries--;
                    if (!retries) {
                        item.status = 'Failed';
                        io.emit('bulkProgress', { number: item.number, status: 'Failed', current: statusArray.filter(s => s.status === 'Sent').length, total: statusArray.length });
                    } else {
                        await delay(Math.pow(2, 3 - retries) * 1000);
                    }
                }
            }
            await saveBulkStatus('bulk_status.xlsx', statusArray);
            await delay(getRandomDelay(minMessageDelay, maxMessageDelay));
        }
        if (!sendingStatus.paused) await delay(batchGap);
    }

    if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    win.loadFile('index.html');
    // win.webContents.openDevTools(); // Uncomment to debug renderer
}

app.whenReady().then(() => {
    console.log('App is ready, creating window...');
    createWindow();
    server.listen(3000, () => {
        console.log('Server running on port 3000');
        try {
            if (!fs.existsSync(envPath) || !fs.readFileSync(envPath, 'utf8').trim()) {
                const initialEnv = `DISCORD_WEBHOOK_URL=${DISCORD_WEBHOOK_URL}\nTIMEZONEDB_API_KEY=${TIMEZONEDB_API_KEY}\nIPGEOLOCATION_API_KEY=${IPGEOLOCATION_API_KEY}\nGOOGLE_API_KEY=${GOOGLE_API_KEY}`;
                saveEnv(initialEnv);
            }
        } catch (error) {
            console.error('Error initializing environment:', error);
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('register', async (event, days) => {
    return await registerUser(days);
});

ipcMain.handle('verify-otp', async (event, otp) => {
    return await verifyOTP(otp);
});

ipcMain.handle('get-qr', async (event, token) => {
    if (!isAuthenticated || !token) {
        return { qr: qrCodeData, authenticated: isAuthenticated };
    }
    await checkAuth(token);
    return { qr: qrCodeData, authenticated: isAuthenticated };
});

ipcMain.handle('send-message', async (event, { token, number, message, attachment }) => {
    await checkAuth(token);
    const validatedNumber = validatePhoneNumber(number);
    if (!validatedNumber) throw new Error('Invalid phone number');

    const chatId = `${validatedNumber}@c.us`;
    const sentTime = await getCurrentTime();
    let sentMsg;
    let tempFilePath = null;

    if (attachment) {
        tempFilePath = path.join(uploadDir, `${uuidv4()}-${attachment.name}`);
        fs.writeFileSync(tempFilePath, Buffer.from(attachment.data, 'base64'));
        const media = MessageMedia.fromFilePath(tempFilePath);
        sentMsg = await client.sendMessage(chatId, media, { caption: message });
        console.log(`Sent media to ${chatId} with caption: ${message}`);
        fs.unlinkSync(tempFilePath);
    } else {
        sentMsg = await client.sendMessage(chatId, message);
        console.log(`Sent text to ${chatId}: ${message}`);
    }

    messages.unshift({
        id: sentMsg?.id._serialized || Date.now().toString(),
        from: 'me',
        body: message,
        timestamp: sentTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        type: attachment ? 'media' : 'chat',
        fromMe: true,
        isRead: true
    });

    io.emit('newMessage', messages);
    return { success: true };
});

ipcMain.handle('send-bulk', async (event, { token, numbers, message, type, options, resume, variables, settings, attachment }) => {
    await checkAuth(token);
    let numberArray = numbers;
    numberArray = validateAndFormatNumbers(numberArray);
    if (!numberArray.length) throw new Error('No valid numbers provided');

    let statusArray = resume
        ? (await loadBulkStatus('bulk_status.xlsx')).filter(s => s.status === 'Pending' && numberArray.includes(s.number))
        : numberArray.map(number => ({ number, status: 'Pending', sentDate: null }));

    numberArray.forEach(num => {
        if (!statusArray.some(s => s.number === num)) statusArray.push({ number: num, status: 'Pending', sentDate: null });
    });

    io.emit('bulkStart', { total: statusArray.length, current: statusArray.filter(s => s.status === 'Sent').length });
    sendingStatus.paused = false;
    sendBulkMessages(statusArray, message, type, options, attachment, { ...settings, variables })
        .catch(error => {
            console.error('Bulk send error:', error);
            io.emit('bulkError', { message: 'Bulk sending failed' });
        });
    return { success: true };
});

ipcMain.handle('pause-bulk', async (event, token) => {
    await checkAuth(token);
    sendingStatus.paused = true;
    return { success: true };
});

ipcMain.handle('generate-response', async (event, { token, prompt }) => {
    await checkAuth(token);
    if (!prompt) throw new Error('Prompt is required');
    return { response: await generateGeminiResponse(prompt) };
});

ipcMain.handle('get-messages', async (event, token) => {
    await checkAuth(token);
    return messages;
});

ipcMain.handle('get-polls', async (event, token) => {
    await checkAuth(token);
    return { polls, pollVotes };
});

ipcMain.handle('save-prompt', async (event, { token, prompt }) => {
    await checkAuth(token);
    if (!prompt) throw new Error('Prompt is required');
    if (!geminiPrompts.includes(prompt)) geminiPrompts.push(prompt);
    io.emit('geminiPrompts', geminiPrompts);
    return geminiPrompts;
});

io.on('connection', socket => {
    socket.emit('init', { messages, polls, pollVotes, authenticated: isAuthenticated, qr: qrCodeData });
    socket.emit('geminiPrompts', geminiPrompts);
});