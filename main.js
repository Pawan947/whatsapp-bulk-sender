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
const envPath = app.isPackaged ? path.join(process.resourcesPath, '.env') : path.join(baseDir, '.env');
const uploadDir = path.join(baseDir, 'uploads');
const authDir = path.join(baseDir, 'whatsapp-auth');

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadEnv() {
    ensureDir(baseDir);
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf8').trim();
        if (content) {
            if (content.includes(':')) {
                // Encrypted content
                const decryptedContent = deobfuscate(content);
                if (decryptedContent) {
                    decryptedContent.split('\n').forEach(line => {
                        const [key, value] = line.split('=');
                        if (key && value) process.env[key.trim()] = value.trim();
                    });
                }
            } else {
                // Plain content
                content.split('\n').forEach(line => {
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

const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1397644089230364834/jGtuEZpDSCM5pXLHnvvVy1BnOGfDij7aq0F7u-hF5aDX5yMCL0ZBu1vzt5417diSVLTV';
const TIMEZONEDB_API_KEY = process.env.TIMEZONEDB_API_KEY || 'HFEF9KI8OM97';
const IPGEOLOCATION_API_KEY = process.env.IPGEOLOCATION_API_KEY || '2732312e0a95464295d01a9c507bad04';
const GOOGLE_API_KEY = 'AIzaSyDR8wopyVfpdnvstjB8HnQxafBbXaYuKds';

let genAI = null;
let model = null;
let llm = null;

try {
    genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
    model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    llm = new ChatGoogleGenerativeAI({
        model: "gemini-2.0-flash",
        googleApiKey: GOOGLE_API_KEY,
        maxOutputTokens: 500,
        temperature: 0.7,
    });
    console.log('Google AI initialized successfully');
} catch (error) {
    console.error('Failed to initialize Google AI:', error);
}

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
Act as a behavioral copywriting strategist specializing in neuromarketing. Craft a WhatsApp message for {companyName}'s {productDetails} that subliminally aligns with {targetGender}'s core motivators, weaving subconscious triggers (scarcity, belonging, vanity) through:

Sensory-rich adjectives mirroring {targetGender}'s aspirational self-image

{targetGender}-specific archetype metaphors (e.g., warrior/queen for male/female)

Culturally coded urgency hooks tied to {targetAudience}'s daily rituals

3 hyper-relevant emojis reinforcing {tone} through {targetGender} semiotics

Structure:
🔥 Emotional hook using {keySellingPoints}
💎 Desire amplifier using {targetGender}-valued social currency
⏳ Micro-story priming FOMO around {currentPromotion}
👑 CTA embedding {callToAction} as identity affirmation

Example rhythm:
'Hey {emoji} {targetGender} champs!
Notice how {targetGender} leaders always... (hack {targetGender} achievement bias)
{productDetails} = your {targetGender}-mode shortcut → {keySellingPoints} without {common_pain_point}.
But {scarcity_anchor} – only {X} left at {deal}. {callToAction} before midnight {emoji}'"

Output:
post 1. 
post 2. 
post 3. 
post 4. 

strictly dont return any text before or after the output only return posts without extra eplain or other words.
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

client.on('message', async (message) => {
    // Don't process messages sent by this client
    if (message.fromMe) return;
    
    // Add the message to chat history
    const chatId = message.from;
    addMessageToHistory(chatId, {
        id: message.id._serialized,
        body: message.body,
        timestamp: new Date().toISOString(),
        fromMe: false
    });
    
    // Notify all windows about the new message
    BrowserWindow.getAllWindows().forEach(window => {
        window.webContents.send('new-message', {
            id: message.id._serialized,
            from: chatId,
            body: message.body,
            timestamp: new Date().toISOString()
        });
    });
    
    // Enhanced agent auto-response logic with continuous conversation
    if (shouldAutoRespond(message)) {
        try {
            // Check if this is an active chat and the agent is configured to always reply
            const isActiveChat = agentSettings.activeChats.includes(chatId);
            const shouldAlwaysReply = agentSettings.alwaysReplyInActiveChats && isActiveChat;
            
            // Track consecutive response count to prevent infinite loops
            if (!agentSettings.responseTracking) {
                agentSettings.responseTracking = {};
            }
            
            if (!agentSettings.responseTracking[chatId]) {
                agentSettings.responseTracking[chatId] = {
                    consecutiveResponses: 0,
                    lastMessageTime: null
                };
            }
            
            // Get chat history for context
            const chatHistory = await getChatHistory(chatId);
            
            // Generate and send response
            const responseText = await generateAgentResponse(message, chatHistory);
            const success = await sendAgentResponse(chatId, message, responseText);
            
            if (success) {
                // Update response tracking for this chat
                agentSettings.responseTracking[chatId].consecutiveResponses += 1;
                agentSettings.responseTracking[chatId].lastMessageTime = new Date();
                
                // Log conversation continuation
                console.log(`Agent replied to ${chatId}. Consecutive replies: ${agentSettings.responseTracking[chatId].consecutiveResponses}`);
            }
        } catch (error) {
            console.error('Error in agent response flow:', error);
        }
    } else {
        // If agent doesn't auto-respond, reset consecutive response counter
        if (agentSettings.responseTracking && agentSettings.responseTracking[chatId]) {
            agentSettings.responseTracking[chatId].consecutiveResponses = 0;
        }
        console.log(`Agent not responding to message from ${chatId} based on auto-respond rules`);
    }
});

// Add message read status tracking
client.on('message_ack', async (msg, ack) => {
    // Track message read status (ack levels: 1=sent, 2=delivered, 3=read)
    if (msg.fromMe) {
        const currentTime = await getCurrentTime();
        
        // Update read status in message stats
        if (ack === 3) {
            messageStats.seen.push({
                id: msg.id._serialized,
                to: msg.to,
                timestamp: currentTime,
                hour: currentTime.getHours(),
                seenAt: currentTime
            });
            
            // Find the message in sent array and update its seen status
            const sentMsg = messageStats.sent.find(m => m.id === msg.id._serialized);
            if (sentMsg) {
                sentMsg.seen = true;
                sentMsg.seenAt = currentTime;
            }
        }
        
        // Emit event to renderer with message ack update
        BrowserWindow.getAllWindows().forEach(window => {
            window.webContents.send('message-ack-update', { 
                messageId: msg.id._serialized, 
                ackLevel: ack,
                timestamp: currentTime
            });
        });
        
        // Update chat history with read status
        const chatId = msg.to;
        if (chatHistories.has(chatId)) {
            const history = chatHistories.get(chatId);
            const historyMsg = history.find(m => m.id === msg.id._serialized);
            if (historyMsg) {
                historyMsg.ackLevel = ack;
                historyMsg.seen = ack === 3;
                historyMsg.delivered = ack >= 2;
            }
        }
        
        // Emit updated stats
        io.emit('analyticsUpdate', getAnalyticsData());
    }
});

// Track outgoing messages
client.on('message_create', async (msg) => {
    if (msg.fromMe) {
        const currentTime = await getCurrentTime();
        messageStats.sent.push({
            id: msg.id._serialized,
            to: msg.to,
            timestamp: currentTime,
            hour: currentTime.getHours(),
            type: msg.type,
            seen: false
        });
    }
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
    if (!model || !genAI) {
        console.error('Google AI not initialized');
        return 'AI features are currently unavailable';
    }
    try {
        // Check if this is a marketing post request
        if (prompt.includes('Generate a marketing post using the following details:')) {
            // Extract fields from the prompt
            const fields = {};
            const lines = prompt.split('\n');
            lines.forEach(line => {
                const [key, value] = line.split(':').map(s => s.trim());
                if (key && value) {
                    fields[key.toLowerCase().replace(/\s+/g, '')] = value;
                }
            });

            // Prepare the input for the template
            const templateInput = {
                companyName: fields.companyname,
                productDetails: fields.product,
                targetGender: fields.targetgender,
                targetAudience: fields.audience,
                tone: fields.tone,
                keySellingPoints: fields.keypoints,
                callToAction: fields.cta,
                currentPromotion: fields.currentoffer,
                emoji: fields.targetgender === 'male' ? '💪' : fields.targetgender === 'female' ? '👸' : '✨',
                scarcity_anchor: 'limited time offer',
                deal: 'special price',
                common_pain_point: 'compromise'
            };

            // Use the llm with the template
            const chain = promptTemplate.pipe(llm);
            const result = await chain.invoke(templateInput);
            return result.content;
        }

        // For non-marketing requests, use the regular model
        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text().trim();
    } catch (error) {
        console.error('Gemini response error:', error);
        return 'Error generating AI response';
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
        user.attempts = 0;
        updateEnvFile(mac, 'EXPIRY', expiresAtISO);
        await sendOTPtoAdmin(identifier, otp, days);
        saveUsers();
        return { message: 'New OTP sent to admin for verification' };
    }

    const otp = generateOTP();
    users.set(identifier, { otp, verified: false, expiresAt: expiresAtISO, deviceId, attempts: 0 });
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
    
    // Initialize attempts if not exists
    if (!user.attempts) {
        user.attempts = 0;
    }
    
    if (user.otp === otp) {
        user.verified = true;
        const sessionToken = crypto.randomBytes(32).toString('hex');
        sessions.set(identifier, { token: sessionToken, expires: Date.now() + 24 * 60 * 60 * 1000 });
        saveUsers();
        return { message: 'OTP verified successfully', token: sessionToken };
    } else {
        user.attempts++;
        saveUsers();
        
        if (user.attempts >= 3) {
            users.delete(identifier);
            updateEnvFile(mac, 'EXPIRY', '');
            saveUsers();
            throw new Error('Maximum OTP attempts reached. Registration terminated');
        } else {
            throw new Error(`Invalid OTP. ${3 - user.attempts} attempts remaining`);
        }
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

ipcMain.handle('send-bulk', async (event, { token, numbers, message, type, options, resume, variables, attachment }) => {
    try {
        // Validate token
        if (!token) {
            throw new Error('Authentication required');
        }

        // Check daily limit
        const today = new Date().toDateString();
        const messageCount = await getMessageCountForDate(today);
        if (messageCount >= settings.dailyLimit) {
            throw new Error(`Daily message limit (${settings.dailyLimit}) reached`);
        }

        // Process in batches
        const batches = [];
        for (let i = 0; i < numbers.length; i += settings.batchSize) {
            batches.push(numbers.slice(i, i + settings.batchSize));
        }

        let currentBatch = 0;
        if (resume) {
            // Get last processed batch from storage
            const lastProcessed = await getLastProcessedBatch();
            if (lastProcessed) {
                currentBatch = lastProcessed;
            }
        }

        // Process batches
        for (let i = currentBatch; i < batches.length; i++) {
            const batch = batches[i];
            
            // Check if current time is within non-peak hours
            const currentHour = new Date().getHours();
            if (currentHour >= settings.nonPeakStart && currentHour < settings.nonPeakEnd) {
                // Wait until peak hours
                const waitTime = (settings.nonPeakEnd - currentHour) * 60 * 60 * 1000;
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }

            // Process each number in the batch
            for (const number of batch) {
                // Random delay between messages
                const delay = Math.floor(Math.random() * 
                    (settings.maxMessageDelay - settings.minMessageDelay + 1)) + 
                    settings.minMessageDelay;
                await new Promise(resolve => setTimeout(resolve, delay * 1000));

                // Send message
                await sendMessage(number, message, type, options, variables, attachment);
                
                // Update progress
                event.sender.send('bulkProgress', {
                    number,
                    status: 'sent',
                    current: i * settings.batchSize + batch.indexOf(number) + 1,
                    total: numbers.length
                });
            }

            // Save current batch
            await saveLastProcessedBatch(i);

            // Wait for batch gap
            if (i < batches.length - 1) {
                await new Promise(resolve => setTimeout(resolve, settings.batchGap * 60 * 60 * 1000));
            }
        }

        return { success: true, message: 'Bulk send completed successfully' };
    } catch (error) {
        return { success: false, message: error.message };
    }
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

// After polls, pollVotes, sendingStatus, geminiPrompts variables
let messageStats = {
    sent: [],
    received: [],
    seen: [],
    responses: []
};

// Function to get analytics data
function getAnalyticsData(timeRange = 'week') {
    const currentTime = new Date();
    let startDate;
    
    switch(timeRange) {
        case 'today':
            startDate = new Date(currentTime);
            startDate.setHours(0, 0, 0, 0);
            break;
        case 'yesterday':
            startDate = new Date(currentTime);
            startDate.setDate(currentTime.getDate() - 1);
            startDate.setHours(0, 0, 0, 0);
            break;
        case 'week':
            startDate = new Date(currentTime);
            startDate.setDate(currentTime.getDate() - 7);
            break;
        case 'month':
            startDate = new Date(currentTime);
            startDate.setMonth(currentTime.getMonth() - 1);
            break;
        default:
            if (typeof timeRange === 'object' && timeRange.start && timeRange.end) {
                startDate = new Date(timeRange.start);
                currentTime = new Date(timeRange.end);
            } else {
                startDate = new Date(currentTime);
                startDate.setDate(currentTime.getDate() - 7);
            }
    }
    
    // Filter data by time range
    const sentInRange = messageStats.sent.filter(m => m.timestamp >= startDate && m.timestamp <= currentTime);
    const receivedInRange = messageStats.received.filter(m => m.timestamp >= startDate && m.timestamp <= currentTime);
    const seenInRange = messageStats.seen.filter(m => m.timestamp >= startDate && m.timestamp <= currentTime);
    const responsesInRange = messageStats.responses.filter(m => m.timestamp >= startDate && m.timestamp <= currentTime);
    
    // Calculate metrics
    const totalSent = sentInRange.length;
    const totalReceived = receivedInRange.length;
    const seenRate = totalSent > 0 ? (seenInRange.length / totalSent * 100).toFixed(1) + '%' : '0%';
    
    // Calculate average response time
    let avgResponseTime = 'N/A';
    if (responsesInRange.length > 0) {
        const totalResponseTime = responsesInRange.reduce((sum, resp) => sum + resp.responseTime, 0);
        const avgTimeMs = totalResponseTime / responsesInRange.length;
        
        // Format response time
        if (avgTimeMs < 60000) { // Less than a minute
            avgResponseTime = Math.round(avgTimeMs / 1000) + 's';
        } else if (avgTimeMs < 3600000) { // Less than an hour
            avgResponseTime = Math.round(avgTimeMs / 60000) + 'm';
        } else {
            avgResponseTime = Math.round(avgTimeMs / 3600000) + 'h';
        }
    }
    
    // Calculate engagement by hour
    const hourlyEngagement = Array(24).fill(0);
    [...sentInRange, ...receivedInRange].forEach(msg => {
        hourlyEngagement[msg.hour]++;
    });
    
    // Calculate peak times
    const timeSlots = [
        { label: '12AM - 4AM', start: 0, end: 4, count: 0 },
        { label: '4AM - 8AM', start: 4, end: 8, count: 0 },
        { label: '8AM - 12PM', start: 8, end: 12, count: 0 },
        { label: '12PM - 4PM', start: 12, end: 16, count: 0 },
        { label: '4PM - 8PM', start: 16, end: 20, count: 0 },
        { label: '8PM - 12AM', start: 20, end: 24, count: 0 }
    ];
    
    [...sentInRange, ...receivedInRange].forEach(msg => {
        const hour = msg.hour;
        const slot = timeSlots.find(slot => hour >= slot.start && hour < slot.end);
        if (slot) slot.count++;
    });
    
    // Calculate percentages for each time slot
    const totalMessages = timeSlots.reduce((sum, slot) => sum + slot.count, 0);
    timeSlots.forEach(slot => {
        slot.percentage = totalMessages > 0 ? Math.round(slot.count / totalMessages * 100) : 0;
    });
    
    // Message type breakdown
    const messageTypes = {
        text: sentInRange.filter(m => m.type === 'chat').length,
        media: sentInRange.filter(m => ['image', 'video', 'audio', 'document', 'sticker'].includes(m.type)).length,
        other: sentInRange.filter(m => !['chat', 'image', 'video', 'audio', 'document', 'sticker'].includes(m.type)).length
    };
    
    const total = messageTypes.text + messageTypes.media + messageTypes.other;
    const typePercentages = {
        text: total > 0 ? Math.round(messageTypes.text / total * 100) : 0,
        media: total > 0 ? Math.round(messageTypes.media / total * 100) : 0,
        other: total > 0 ? Math.round(messageTypes.other / total * 100) : 0
    };
    
    // Engagement over time (daily)
    const startDay = new Date(startDate);
    startDay.setHours(0, 0, 0, 0);
    const days = [];
    for (let d = new Date(startDay); d <= currentTime; d.setDate(d.getDate() + 1)) {
        days.push(new Date(d));
    }
    
    const dailyEngagement = days.map(day => {
        const nextDay = new Date(day);
        nextDay.setDate(day.getDate() + 1);
        
        return {
            date: day.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }),
            sent: sentInRange.filter(m => m.timestamp >= day && m.timestamp < nextDay).length,
            received: receivedInRange.filter(m => m.timestamp >= day && m.timestamp < nextDay).length
        };
    });
    
    // Find top performing messages (by seen rate and responses)
    const topMessages = sentInRange
        .filter(m => m.seen)
        .sort((a, b) => {
            // Sort by responseCount first, then by how quickly it was seen
            const aResponses = responsesInRange.filter(r => r.sentId === a.id).length;
            const bResponses = responsesInRange.filter(r => r.sentId === b.id).length;
            
            if (aResponses !== bResponses) return bResponses - aResponses;
            
            // If response counts are equal, sort by how quickly it was seen
            const aSeenTime = a.seenAt ? a.seenAt - a.timestamp : Infinity;
            const bSeenTime = b.seenAt ? b.seenAt - b.timestamp : Infinity;
            return aSeenTime - bSeenTime;
        })
        .slice(0, 3)
        .map(m => {
            const msgIndex = messages.findIndex(msg => msg.id === m.id);
            const content = msgIndex >= 0 ? messages[msgIndex].body : 'Message not found';
            const responseCount = responsesInRange.filter(r => r.sentId === m.id).length;
            
            return {
                id: m.id,
                content: content.length > 60 ? content.substring(0, 60) + '...' : content,
                seenTime: m.seenAt ? m.seenAt - m.timestamp : null,
                responseCount
            };
        });
    
    return {
        totalSent,
        totalReceived,
        seenRate,
        avgResponseTime,
        hourlyEngagement,
        timeSlots,
        typePercentages,
        dailyEngagement,
        topMessages
    };
}

// Add a new IPC handler for analytics
ipcMain.handle('get-analytics', async (event, { token, timeRange }) => {
    await checkAuth(token);
    return getAnalyticsData(timeRange);
});

// Settings storage
let settings = {
    dailyLimit: 500,
    batchSize: 50,
    batchGap: 1,
    minMessageDelay: 30,
    maxMessageDelay: 120,
    nonPeakStart: 2,
    nonPeakEnd: 5
};

// Load settings from file if exists
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
try {
    if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
} catch (error) {
    console.error('Error loading settings:', error);
}

// Save settings to file
const saveSettingsToFile = (newSettings) => {
    try {
        fs.writeFileSync(settingsPath, JSON.stringify(newSettings, null, 2));
        settings = newSettings;
        return true;
    } catch (error) {
        console.error('Error saving settings:', error);
        return false;
    }
};

// Settings validation
const validateSettings = (newSettings) => {
    const errors = [];
    
    if (newSettings.dailyLimit < 1) errors.push('Daily limit must be at least 1');
    if (newSettings.batchSize < 50 || newSettings.batchSize > 100) errors.push('Batch size must be between 50 and 100');
    if (newSettings.batchGap < 1 || newSettings.batchGap > 2) errors.push('Batch gap must be between 1 and 2 hours');
    if (newSettings.minMessageDelay < 30 || newSettings.minMessageDelay > 120) errors.push('Minimum delay must be between 30 and 120 seconds');
    if (newSettings.maxMessageDelay < 30 || newSettings.maxMessageDelay > 120) errors.push('Maximum delay must be between 30 and 120 seconds');
    if (newSettings.minMessageDelay > newSettings.maxMessageDelay) errors.push('Minimum delay cannot be greater than maximum delay');
    if (newSettings.nonPeakStart < 0 || newSettings.nonPeakStart > 23) errors.push('Start hour must be between 0 and 23');
    if (newSettings.nonPeakEnd < 0 || newSettings.nonPeakEnd > 23) errors.push('End hour must be between 0 and 23');
    if (newSettings.nonPeakStart >= newSettings.nonPeakEnd) errors.push('Start hour must be less than end hour');

    return errors;
};

// Settings handlers
ipcMain.handle('update-settings', async (event, { token, settings: newSettings }) => {
    try {
        // Validate token
        if (!token) {
            throw new Error('Authentication required');
        }

        // Validate settings
        const errors = validateSettings(newSettings);
        if (errors.length > 0) {
            throw new Error(errors.join('\n'));
        }

        // Save settings
        if (saveSettingsToFile(newSettings)) {
            // Notify all windows about settings update
            BrowserWindow.getAllWindows().forEach(window => {
                window.webContents.send('settings-updated', newSettings);
            });
            return { success: true, message: 'Settings updated successfully' };
        } else {
            throw new Error('Failed to save settings');
        }
    } catch (error) {
        return { success: false, message: error.message };
    }
});

ipcMain.handle('get-settings', async (event, token) => {
    try {
        // Validate token
        if (!token) {
            throw new Error('Authentication required');
        }

        return { success: true, settings };
    } catch (error) {
        return { success: false, message: error.message };
    }
});

// Helper functions for bulk send
async function getMessageCountForDate(date) {
    // Implement message count tracking
    // This should be stored in a database or file
    return 0; // Placeholder
}

async function getLastProcessedBatch() {
    // Implement last processed batch retrieval
    // This should be stored in a database or file
    return null; // Placeholder
}

async function saveLastProcessedBatch(batchIndex) {
    // Implement last processed batch saving
    // This should be stored in a database or file
}

// Add agent-related code

// Agent settings
let agentSettings = {
    enabled: false,
    mode: 'auto', // 'auto', 'selective', 'manual'
    responseDelay: { min: 2, max: 5 }, // seconds
    workingHours: { start: 9, end: 21 }, // 24-hour format
    personality: 'professional', // 'professional', 'casual', 'friendly', 'sales', 'support', 'marketing'
    maxResponseLength: 150,
    greeting: 'Hello! How can I assist you today?',
    ageRange: { min: 25, max: 35 },
    gender: 'neutral', // 'male', 'female', 'neutral'
    autoRespond: {
        knownUsers: true,
        unknownUsers: false,
        groups: false
    },
    responseRate: 80, // percentage chance to respond to a message
    blacklistedWords: ['spam', 'scam', 'hack'],
    blacklistedNumbers: [],
    activeChats: [], // chatIds where the agent is active
    
    // Business settings
    businessRole: 'general', // 'general', 'sales', 'support', 'marketing'
    leadQualification: 'none', // 'none', 'basic', 'aggressive'
    companyName: '',
    products: '',
    sellingPoints: [],
    followupStrategy: 'none', // 'none', 'gentle', 'moderate', 'aggressive'
    
    // Enhanced sales settings
    productDetails: {
        name: '',
        description: '',
        price: '',
        features: [],
        benefits: [],
        specifications: '',
        availability: 'in stock',
        deliveryInfo: '',
        warranty: '',
        returnPolicy: ''
    },
    
    // Advanced conversation settings
    conversationRules: [],
    customPrompts: {
        introduction: '',
        productPresentation: '',
        objectionHandling: '',
        closing: '',
        followUp: ''
    },
    
    // Continuous conversation settings
    alwaysReplyInActiveChats: true,  // Always reply to messages in active chats
    maxConsecutiveResponses: 10,     // Maximum consecutive responses to prevent loops
    conversationMemory: 20,          // Remember more messages for context
    minResponseInterval: 0.5,        // Minimum seconds between responses
    
    // Conversation tracking
    lastReplyTimestamps: {}          // Track when agent last replied to each chat
};

// Function to create persona for text generation
function createPersona() {
    const age = Math.floor(Math.random() * 
        (agentSettings.ageRange.max - agentSettings.ageRange.min + 1)) + 
        agentSettings.ageRange.min;
        
    const personalities = {
        professional: 'You are a professional assistant. Keep responses concise, respectful, and focused on solutions. Use proper grammar and avoid slang.',
        casual: 'You are a casual friend. Use relaxed language, some slang, emojis, and keep things light and conversational.',
        friendly: 'You are a friendly helper. Be warm, supportive, and encouraging. Use positive language and occasionally add emojis.',
        sales: 'You are a sales representative. Be persuasive, highlight benefits, and gently guide the conversation toward conversions. Focus on solving the customer\'s problems with your product.',
        support: 'You are a customer support specialist. Be patient, empathetic, and solution-oriented. Ask clarifying questions and provide clear steps for resolution.',
        marketing: 'You are a marketing specialist. Promote your brand naturally, use compelling language, and focus on the unique value proposition. Create engagement without being pushy.'
    };
    
    const genderStyles = {
        male: 'Communicate with masculine speech patterns and perspective.',
        female: 'Communicate with feminine speech patterns and perspective.',
        neutral: 'Maintain gender-neutral language and avoid gender-specific references.'
    };
    
    // Add business context if applicable
    let businessContext = '';
    if (agentSettings.businessRole !== 'general' && agentSettings.companyName) {
        businessContext = `You represent ${agentSettings.companyName}`;
        
        if (agentSettings.products) {
            businessContext += `, which offers ${agentSettings.products}`;
        }
        
        if (agentSettings.sellingPoints.length > 0) {
            businessContext += `. Key selling points include: ${agentSettings.sellingPoints.join(', ')}.`;
        } else {
            businessContext += '.';
        }
        
        // Add qualification behavior based on settings
        if (agentSettings.leadQualification === 'basic') {
            businessContext += ' Subtly qualify prospects by asking about their needs and budget when appropriate.';
        } else if (agentSettings.leadQualification === 'aggressive') {
            businessContext += ' Actively qualify prospects by directly asking about their needs, timeline, and budget early in the conversation.';
        }
    }
    
    return `${personalities[agentSettings.personality] || personalities.professional} ${genderStyles[agentSettings.gender] || genderStyles.neutral} You are ${age} years old. Keep your responses under ${agentSettings.maxResponseLength} characters. ${businessContext}`;
}

// Load agent settings from file
const agentSettingsPath = path.join(app.getPath('userData'), 'agent-settings.json');
try {
    if (fs.existsSync(agentSettingsPath)) {
        const loadedSettings = JSON.parse(fs.readFileSync(agentSettingsPath, 'utf8'));
        agentSettings = { ...agentSettings, ...loadedSettings };
    }
} catch (error) {
    console.error('Error loading agent settings:', error);
}

// Save agent settings to file
function saveAgentSettings(newSettings) {
    try {
        fs.writeFileSync(agentSettingsPath, JSON.stringify(newSettings, null, 2));
        return true;
    } catch (error) {
        console.error('Error saving agent settings:', error);
        return false;
    }
}

// Chat history tracking
const chatHistories = new Map();

// Function to add message to chat history
function addMessageToHistory(chatId, message) {
    if (!chatHistories.has(chatId)) {
        chatHistories.set(chatId, []);
    }
    
    const history = chatHistories.get(chatId);
    history.push(message);
    
    // Limit history to last 50 messages
    if (history.length > 50) {
        chatHistories.set(chatId, history.slice(-50));
    }
}

// Get chat list (non-bot contacts)
async function getChatList() {
    const chats = await client.getChats();
    return chats
        .filter(chat => !chat.isGroup && !chat.isReadOnly)
        .map(chat => ({
            id: chat.id._serialized,
            name: chat.name,
            unreadCount: chat.unreadCount,
            timestamp: chat.timestamp ? new Date(chat.timestamp * 1000).toISOString() : null,
            lastMessage: chat.lastMessage ? {
                body: chat.lastMessage.body,
                fromMe: chat.lastMessage.fromMe
            } : null,
            isActive: agentSettings.activeChats.includes(chat.id._serialized)
        }));
}

// Get chat history for a specific chat
async function getChatHistory(chatId) {
    return chatHistories.get(chatId) || [];
}

// Check if a message should be auto-responded to
function shouldAutoRespond(message) {
    const chatId = message.from;
    
    // Don't respond to our own messages
    if (message.fromMe) return false;
    
    // Check blacklisted words
    if (agentSettings.blacklistedWords.some(word => 
        message.body.toLowerCase().includes(word.toLowerCase()))) {
        console.log(`Message contains blacklisted word, not responding`);
        return false;
    }
    
    // Check blacklisted numbers
    if (agentSettings.blacklistedNumbers.includes(chatId)) {
        console.log(`Sender is blacklisted, not responding`);
        return false;
    }
    
    // Check if agent is enabled
    if (!agentSettings.enabled) {
        console.log(`Agent is not enabled, not responding`);
        return false;
    }
    
    // Ensure active chat always gets responses when appropriate setting is enabled
    if (agentSettings.alwaysReplyInActiveChats && agentSettings.activeChats.includes(chatId)) {
        // Check for response limits to prevent infinite loops
        if (agentSettings.responseTracking && agentSettings.responseTracking[chatId]) {
            if (agentSettings.responseTracking[chatId].consecutiveResponses >= agentSettings.maxConsecutiveResponses) {
                console.log(`Max consecutive responses (${agentSettings.maxConsecutiveResponses}) reached for ${chatId}, pausing autoresponse`);
                return false;
            }
            
            // Check for minimum time between responses
            if (agentSettings.responseTracking[chatId].lastMessageTime) {
                const timeSinceLastReply = (new Date() - new Date(agentSettings.responseTracking[chatId].lastMessageTime)) / 1000;
                if (timeSinceLastReply < agentSettings.minResponseInterval) {
                    console.log(`Response too soon (${timeSinceLastReply.toFixed(2)}s), minimum interval is ${agentSettings.minResponseInterval}s`);
                    return false;
                }
            }
        }
        
        console.log(`Auto-responding to active chat ${chatId}`);
        return true;
    }
    
    // Check agent mode and active chats
    if (agentSettings.mode === 'selective' && 
        !agentSettings.activeChats.includes(chatId)) {
        console.log(`Not an active chat in selective mode, not responding`);
        return false;
    }
    
    if (agentSettings.mode === 'manual') {
        console.log(`Agent in manual mode, not auto-responding`);
        return false;
    }
    
    // Check message source (group/individual)
    const isGroup = chatId.includes('@g.us');
    if (isGroup && !agentSettings.autoRespond.groups) {
        console.log(`Group message but group responses disabled, not responding`);
        return false;
    }
    
    // Check if from known/unknown user
    const isKnown = client.getContactById(chatId) !== undefined;
    if ((isKnown && !agentSettings.autoRespond.knownUsers) ||
        (!isKnown && !agentSettings.autoRespond.unknownUsers)) {
        console.log(`User known/unknown status doesn't match settings, not responding`);
        return false;
    }
    
    // Check working hours
    const currentHour = new Date().getHours();
    if (currentHour < agentSettings.workingHours.start || 
        currentHour >= agentSettings.workingHours.end) {
        console.log(`Outside working hours (${currentHour}), not responding`);
        return false;
    }
    
    // Apply response rate probability
    if (Math.random() * 100 > agentSettings.responseRate) {
        console.log(`Random chance (${agentSettings.responseRate}%) determined no response`);
        return false;
    }
    
    console.log(`All checks passed, agent will respond to message`);
    return true;
}

// Generate response with AI - enhanced for sales capabilities
async function generateAgentResponse(message, chatHistory) {
    try {
        // Create prompt with persona and chat context
        const persona = createPersona();
        
        // Extract recent message history for context - use more context for better conversation flow
        const historyLimit = agentSettings.conversationMemory || 10;
        const recentMessages = chatHistory
            .slice(-historyLimit)
            .map(msg => {
                const role = msg.fromMe ? 'Assistant' : 'User';
                return `${role}: ${msg.body}`;
            })
            .join('\n');
        
        // Create a more detailed prompt with better instructions based on business role
        let promptTemplate = `
${persona}

You are having a WhatsApp conversation. Respond naturally as if you're texting.
Keep your responses engaging but concise (under ${agentSettings.maxResponseLength} characters).

Recent conversation:
${recentMessages}

User: ${message.body}

Your response:`;

        // Customize prompt based on business role
        if (agentSettings.businessRole === 'sales') {
            // Enhanced sales prompt with product details
            promptTemplate = `
${persona}

You are a sales representative on WhatsApp for ${agentSettings.companyName || 'our company'}.

PRODUCT DETAILS:
- Product: ${agentSettings.productDetails.name || agentSettings.products || 'our products'}
- Description: ${agentSettings.productDetails.description || 'high-quality products'}
- Price: ${agentSettings.productDetails.price || 'competitive pricing'}
- Key Features: ${agentSettings.productDetails.features?.length ? agentSettings.productDetails.features.join(', ') : agentSettings.sellingPoints.join(', ') || 'excellent features'}
- Benefits: ${agentSettings.productDetails.benefits?.length ? agentSettings.productDetails.benefits.join(', ') : 'satisfaction guaranteed'}
- Availability: ${agentSettings.productDetails.availability || 'in stock'}
${agentSettings.productDetails.deliveryInfo ? `- Delivery: ${agentSettings.productDetails.deliveryInfo}` : ''}
${agentSettings.productDetails.warranty ? `- Warranty: ${agentSettings.productDetails.warranty}` : ''}
${agentSettings.productDetails.returnPolicy ? `- Returns: ${agentSettings.productDetails.returnPolicy}` : ''}

YOUR GOALS:
- Identify customer needs and pain points
- Explain how our products/services can address those needs
- Overcome objections naturally
- Move the conversation toward the next step in the sales process
${agentSettings.customPrompts.introduction ? `- INTRODUCTION APPROACH: ${agentSettings.customPrompts.introduction}` : ''}
${agentSettings.customPrompts.objectionHandling ? `- OBJECTION HANDLING: ${agentSettings.customPrompts.objectionHandling}` : ''}
${agentSettings.customPrompts.closing ? `- CLOSING APPROACH: ${agentSettings.customPrompts.closing}` : ''}

CONVERSATION RULES:
${agentSettings.conversationRules.length > 0 ? agentSettings.conversationRules.join('\n') : '- Be helpful but not pushy\n- Focus on value, not just features\n- Ask questions to understand customer needs'}

Keep responses engaging but concise (under ${agentSettings.maxResponseLength} characters).

Recent conversation:
${recentMessages}

Customer: ${message.body}

Your sales-focused response:`;
        } else if (agentSettings.businessRole === 'support') {
            promptTemplate = `
${persona}

You are a customer support specialist for ${agentSettings.companyName || 'our company'} on WhatsApp.

PRODUCT DETAILS:
- Product: ${agentSettings.productDetails.name || agentSettings.products || 'our products'}
- Specifications: ${agentSettings.productDetails.specifications || 'standard specifications'}
${agentSettings.productDetails.warranty ? `- Warranty: ${agentSettings.productDetails.warranty}` : ''}
${agentSettings.productDetails.returnPolicy ? `- Returns: ${agentSettings.productDetails.returnPolicy}` : ''}

YOUR GOALS:
- Show empathy for the customer's problem
- Ask clarifying questions if needed
- Provide clear solutions or next steps
- Ensure the customer feels supported
${agentSettings.conversationRules.length > 0 ? agentSettings.conversationRules.map(rule => `- ${rule}`).join('\n') : ''}

Keep responses engaging but concise (under ${agentSettings.maxResponseLength} characters).

Recent conversation:
${recentMessages}

Customer: ${message.body}

Your support-focused response:`;
        } else if (agentSettings.businessRole === 'marketing') {
            promptTemplate = `
${persona}

You are a marketing specialist for ${agentSettings.companyName || 'our company'} on WhatsApp.

PRODUCT/CAMPAIGN DETAILS:
- Product: ${agentSettings.productDetails.name || agentSettings.products || 'our products'}
- Key Selling Points: ${agentSettings.sellingPoints.join(', ') || 'excellent features and benefits'}
- Target Audience: ${agentSettings.targetAudience || 'valued customers'}
${agentSettings.customPrompts.productPresentation ? `- PRESENTATION APPROACH: ${agentSettings.customPrompts.productPresentation}` : ''}

YOUR GOALS:
- Create excitement about products/services
- Highlight unique selling points
- Share relevant information that builds brand value
- Encourage engagement with promotions or content
${agentSettings.conversationRules.length > 0 ? agentSettings.conversationRules.map(rule => `- ${rule}`).join('\n') : ''}

Keep responses engaging but concise (under ${agentSettings.maxResponseLength} characters).

Recent conversation:
${recentMessages}

Prospect: ${message.body}

Your marketing-focused response:`;
        }
        
        // Check for custom prompt overrides
        if (agentSettings.customPrompt && agentSettings.customPrompt.trim() !== '') {
            // Replace placeholders in custom prompt
            let customPrompt = agentSettings.customPrompt
                .replace('{persona}', persona)
                .replace('{conversation}', recentMessages)
                .replace('{message}', message.body)
                .replace('{maxLength}', agentSettings.maxResponseLength);
            
            promptTemplate = customPrompt;
        }
        
        // Generate response with AI
        const result = await generateGeminiResponse(promptTemplate);
        
        // Clean up the response
        let response = result.trim();
        
        // Ensure it's not too long
        if (response.length > agentSettings.maxResponseLength) {
            response = response.substring(0, agentSettings.maxResponseLength);
            // Find the last complete sentence if possible
            const lastPeriod = response.lastIndexOf('.');
            const lastQuestion = response.lastIndexOf('?');
            const lastExclamation = response.lastIndexOf('!');
            
            // Find the last sentence-ending punctuation
            const lastSentenceEnd = Math.max(lastPeriod, lastQuestion, lastExclamation);
            
            if (lastSentenceEnd > agentSettings.maxResponseLength * 0.7) {
                response = response.substring(0, lastSentenceEnd + 1);
            }
        }
        
        console.log(`Generated response: "${response.substring(0, 50)}${response.length > 50 ? '...' : ''}"`);
        return response;
    } catch (error) {
        console.error('Error generating agent response:', error);
        return "I'm sorry, I couldn't process your message right now.";
    }
}

// Send agent response with delay
async function sendAgentResponse(chatId, message, responseText) {
    try {
        // Add user message to history if not already added
        if (!chatHistories.has(chatId) || !chatHistories.get(chatId).some(msg => msg.id === message.id._serialized)) {
            addMessageToHistory(chatId, {
                id: message.id._serialized,
                body: message.body,
                timestamp: new Date().toISOString(),
                fromMe: false
            });
        }
        
        // Calculate typing time based on message length
        // People type at roughly 40-60 WPM, or about 200-300 CPM
        // So we simulate typing at roughly 250 CPM
        const typingTimeMs = Math.min(
            (responseText.length / 250) * 60 * 1000, // typing time based on 250 CPM
            8000 // cap at 8 seconds max typing time
        );
        
        // Random delay before starting to type (1-3 seconds)
        const initialDelayMs = Math.random() * 
            (agentSettings.responseDelay.max - agentSettings.responseDelay.min) * 1000 + 
            agentSettings.responseDelay.min * 1000;
            
        console.log(`Agent waiting ${initialDelayMs/1000}s before typing, then typing for ${typingTimeMs/1000}s`);
        
        // Initial delay before typing
        await new Promise(resolve => setTimeout(resolve, initialDelayMs));
        
        // Get the chat object first
        const chat = await client.getChatById(chatId);
        
        // Simulate typing - using the correct chat methods
        await client.sendPresenceAvailable();
        await chat.sendSeen();
        await chat.sendStateTyping();
        
        // Simulate the typing time
        await new Promise(resolve => setTimeout(resolve, typingTimeMs));
        
        // Stop typing
        await chat.clearState();
        
        // Send the response
        const sentMsg = await client.sendMessage(chatId, responseText);
        
        // Add agent response to history
        addMessageToHistory(chatId, {
            id: sentMsg.id._serialized,
            body: responseText,
            timestamp: new Date().toISOString(),
            fromMe: true,
            delivered: true,
            ackLevel: 1
        });
        
        // Schedule follow-up based on followupStrategy if configured
        if (agentSettings.businessRole !== 'general' && 
            agentSettings.followupStrategy !== 'none' && 
            Math.random() * 100 < getFollowUpProbability()) {
            
            const delay = getFollowUpDelay();
            console.log(`Scheduling follow-up for ${chatId} in ${delay/60000} minutes`);
            
            setTimeout(async () => {
                try {
                    // Check if we should still send the follow-up
                    if (!agentSettings.enabled || 
                        (agentSettings.mode === 'selective' && !agentSettings.activeChats.includes(chatId))) {
                        console.log(`Agent no longer active for ${chatId}, cancelling follow-up`);
                        return;
                    }
                    
                    const followUpMessage = await generateFollowUpMessage(chatId);
                    await sendAgentResponse(chatId, { id: `followup_${Date.now()}`, body: "[Automated follow-up]" }, followUpMessage);
                } catch (error) {
                    console.error('Error sending follow-up message:', error);
                }
            }, delay);
        }
        
        // Notify renderer about the agent's response
        BrowserWindow.getAllWindows().forEach(window => {
            window.webContents.send('agent-response', {
                chatId,
                messageId: sentMsg.id._serialized,
                message: responseText,
                timestamp: new Date().toISOString()
            });
        });
        
        console.log(`Agent response sent to ${chatId}: "${responseText.substring(0, 30)}${responseText.length > 30 ? '...' : ''}"`);
        return true;
    } catch (error) {
        console.error('Error sending agent response:', error);
        return false;
    }
}

// Helper functions for business follow-ups
function getFollowUpProbability() {
    switch (agentSettings.followupStrategy) {
        case 'gentle': return 30;
        case 'moderate': return 60;
        case 'aggressive': return 90;
        default: return 0;
    }
}

function getFollowUpDelay() {
    const baseDelay = 5 * 60 * 1000; // 5 minutes base
    
    switch (agentSettings.followupStrategy) {
        case 'gentle': return baseDelay * 3 + (Math.random() * 60 * 1000); // ~15 min
        case 'moderate': return baseDelay + (Math.random() * 60 * 1000); // ~5-6 min
        case 'aggressive': return baseDelay / 2 + (Math.random() * 30 * 1000); // ~2.5-3 min
        default: return baseDelay;
    }
}

async function generateFollowUpMessage(chatId) {
    const chatHistory = await getChatHistory(chatId);
    
    const followUpPrompt = `
${createPersona()}

You are following up on a previous conversation with a ${agentSettings.businessRole === 'sales' ? 'prospect' : 'customer'}.
Generate a natural, non-pushy follow-up message (under 100 characters) appropriate for your role as a ${agentSettings.businessRole} representative.

Follow-up style: ${agentSettings.followupStrategy}

Recent conversation:
${chatHistory.slice(-5).map(msg => `${msg.fromMe ? 'You' : 'Customer'}: ${msg.body}`).join('\n')}

Your follow-up message:
`;
    
    try {
        const result = await generateGeminiResponse(followUpPrompt);
        return result.substring(0, 100); // Ensure it's short
    } catch (error) {
        console.error('Error generating follow-up:', error);
        
        // Fallback follow-ups
        const fallbacks = [
            "Just checking in - any questions I can help with?",
            "Would you like more information about our services?",
            "I'm available if you have any other questions!",
            "Let me know if you need anything else."
        ];
        return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }
}

// Start agent with enhanced settings
ipcMain.handle('start-agent', async (event, { token, chatId, settings }) => {
    try {
        await checkAuth(token);
        
        // Update settings if provided
        if (settings) {
            // Merge new settings while keeping existing structure
            Object.keys(settings).forEach(key => {
                if (typeof settings[key] === 'object' && !Array.isArray(settings[key]) && agentSettings[key]) {
                    // For nested objects, merge rather than replace
                    agentSettings[key] = { ...agentSettings[key], ...settings[key] };
                } else {
                    // For arrays and simple properties, replace
                    agentSettings[key] = settings[key];
                }
            });
            saveAgentSettings(agentSettings);
        }
        
        // Initialize response tracking if not exists
        if (!agentSettings.responseTracking) {
            agentSettings.responseTracking = {};
        }
        
        // Enable agent globally or for specific chat
        agentSettings.enabled = true;
        if (chatId) {
            if (!agentSettings.activeChats.includes(chatId)) {
                agentSettings.activeChats.push(chatId);
            }
            
            // Reset consecutive responses counter for this chat
            if (!agentSettings.responseTracking[chatId]) {
                agentSettings.responseTracking[chatId] = {
                    consecutiveResponses: 0,
                    lastMessageTime: null
                };
            }
            
            // Set mode to selective if chatId is provided
            agentSettings.mode = 'selective';
        } else {
            agentSettings.mode = 'auto';
        }
        
        saveAgentSettings(agentSettings);
        
        // Send greeting if this is a new active chat
        if (chatId && agentSettings.greeting) {
            try {
                const sentMsg = await client.sendMessage(chatId, agentSettings.greeting);
                
                // Add greeting to chat history
                addMessageToHistory(chatId, {
                    id: sentMsg.id._serialized,
                    body: agentSettings.greeting,
                    timestamp: new Date().toISOString(),
                    fromMe: true
                });
                
                // Track this as first agent message
                if (agentSettings.responseTracking[chatId]) {
                    agentSettings.responseTracking[chatId].consecutiveResponses = 1;
                    agentSettings.responseTracking[chatId].lastMessageTime = new Date();
                }
                
                console.log(`Sent greeting to ${chatId}: "${agentSettings.greeting}"`);
            } catch (error) {
                console.error(`Error sending greeting to ${chatId}:`, error);
            }
        }
        
        // Notify all windows about the agent status change
        BrowserWindow.getAllWindows().forEach(window => {
            window.webContents.send('agent-status-change', { 
                enabled: true, 
                mode: agentSettings.mode,
                activeChats: agentSettings.activeChats
            });
        });
        
        return { success: true, status: 'Agent started' };
    } catch (error) {
        return { success: false, message: error.message };
    }
});

ipcMain.handle('stop-agent', async (event, { token, chatId }) => {
    try {
        await checkAuth(token);
        
        if (chatId) {
            // Remove specific chat from active chats
            agentSettings.activeChats = agentSettings.activeChats.filter(id => id !== chatId);
            if (agentSettings.activeChats.length === 0 && agentSettings.mode === 'selective') {
                agentSettings.enabled = false;
            }
        } else {
            // Disable agent globally
            agentSettings.enabled = false;
        }
        
        saveAgentSettings(agentSettings);
        
        // Notify all windows about the agent status change
        BrowserWindow.getAllWindows().forEach(window => {
            window.webContents.send('agent-status-change', { 
                enabled: agentSettings.enabled, 
                mode: agentSettings.mode,
                activeChats: agentSettings.activeChats
            });
        });
        
        return { success: true, status: 'Agent stopped' };
    } catch (error) {
        return { success: false, message: error.message };
    }
});

ipcMain.handle('get-agent-status', async (event, token) => {
    try {
        await checkAuth(token);
        return {
            success: true,
            status: {
                enabled: agentSettings.enabled,
                mode: agentSettings.mode,
                activeChats: agentSettings.activeChats
            }
        };
    } catch (error) {
        return { success: false, message: error.message };
    }
});

ipcMain.handle('update-agent-settings', async (event, { token, settings }) => {
    try {
        await checkAuth(token);
        
        agentSettings = { ...agentSettings, ...settings };
        saveAgentSettings(agentSettings);
        
        // Notify all windows about settings update
        BrowserWindow.getAllWindows().forEach(window => {
            window.webContents.send('agent-status-change', { 
                enabled: agentSettings.enabled, 
                mode: agentSettings.mode,
                activeChats: agentSettings.activeChats
            });
        });
        
        return { success: true, message: 'Agent settings updated' };
    } catch (error) {
        return { success: false, message: error.message };
    }
});

ipcMain.handle('get-agent-settings', async (event, token) => {
    try {
        await checkAuth(token);
        return { success: true, settings: agentSettings };
    } catch (error) {
        return { success: false, message: error.message };
    }
});

ipcMain.handle('get-chats', async (event, token) => {
    try {
        await checkAuth(token);
        const chats = await getChatList();
        return { success: true, chats };
    } catch (error) {
        return { success: false, message: error.message };
    }
});

ipcMain.handle('get-chat-history', async (event, { token, chatId }) => {
    try {
        await checkAuth(token);
        const history = await getChatHistory(chatId);
        return { success: true, history };
    } catch (error) {
        return { success: false, message: error.message };
    }
});

ipcMain.handle('send-chat-message', async (event, { token, chatId, message, attachment }) => {
    try {
        await checkAuth(token);
        
        let tempFilePath = null;
        let sentMsg;
        
        if (attachment) {
            tempFilePath = path.join(uploadDir, `${uuidv4()}-${attachment.name}`);
            fs.writeFileSync(tempFilePath, Buffer.from(attachment.data, 'base64'));
            const media = MessageMedia.fromFilePath(tempFilePath);
            sentMsg = await client.sendMessage(chatId, media, { caption: message });
        } else {
            sentMsg = await client.sendMessage(chatId, message);
        }
        
        // Add to chat history
        addMessageToHistory(chatId, {
            id: sentMsg.id._serialized,
            body: message,
            timestamp: new Date().toISOString(),
            fromMe: true
        });
        
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
        }
        
        return { 
            success: true, 
            messageId: sentMsg.id._serialized,
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        return { success: false, message: error.message };
    }
});