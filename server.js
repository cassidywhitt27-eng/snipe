// ========== COMPLETE FIXED SERVER.JS WITH FIREBASE ADMIN LISTS ==========

const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');
const {
    Connection,
    PublicKey,
    Keypair,
    Transaction,
    TransactionInstruction,
    SystemProgram,
    LAMPORTS_PER_SOL,
    ComputeBudgetProgram
} = require('@solana/web3.js');

const bs58 = require('bs58');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
// Add these imports at the top with other requires
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const https = require('https');
const { BlockchainTokenListener } = require('./blockchain-listener');

const { chromium } = require('playwright');
const UserAgent = require('user-agents');
const timingLogFile = path.join(__dirname, 'token_timing_log.txt');
const activeScrapingSessions = new Map();
const scrapingResults = new Map();
const SCRAPING_RESULT_CACHE_TIME = 30000;
dotenv.config();

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const TOKEN_TIMING_LOGS_DIR = path.join(__dirname, 'token-timing-logs');
let blockchainListener = null;

// ========== COMPREHENSIVE LOGGING SETUP ==========
const LOG_DIR = path.join(__dirname, 'logs');

// Ensure logs directory exists
try {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        console.log('📁 Logs directory created');
    }
} catch (error) {
    console.error('Error creating logs directory:', error);
}

// Create Winston logger with daily rotation
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => {
            return `[${timestamp}] ${message}`;
        })
    ),
    transports: [
        // Daily rotating file
        new DailyRotateFile({
            filename: path.join(LOG_DIR, 'server-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '14d',
            zippedArchive: true
        }),
        // Current session file
        new winston.transports.File({
            filename: path.join(LOG_DIR, 'current-session.log')
        })
    ]
});

// Override console methods to also write to log file
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;

console.log = function (...args) {
    const message = args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');

    originalLog.apply(console, args);
    logger.info(`[LOG] ${message}`);
};

console.error = function (...args) {
    const message = args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');

    originalError.apply(console, args);
    logger.error(`[ERROR] ${message}`);
};

console.warn = function (...args) {
    const message = args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');

    originalWarn.apply(console, args);
    logger.warn(`[WARN] ${message}`);
};

console.info = function (...args) {
    const message = args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');

    originalInfo.apply(console, args);
    logger.info(`[INFO] ${message}`);
};

// Capture uncaught exceptions and unhandled rejections
process.on('uncaughtException', (error) => {
    logger.error(`[UNCAUGHT EXCEPTION] ${error.stack || error.message}`);
    originalError('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error(`[UNHANDLED REJECTION] ${reason}`);
    originalError('Unhandled Rejection at:', promise, 'reason:', reason);
});

console.log('📝 Comprehensive logging system initialized');
console.log(`📁 Log files location: ${LOG_DIR}`);

const COMMUNITY_CACHE_FILE = path.join(__dirname, 'usedCommunities.json');
const TWEETS_CACHE_FILE = path.join(__dirname, 'usedTweets.json'); // ADD THIS
const FIREBASE_SYNC_INTERVAL = 15 * 60 * 1000; // 15 minutes in milliseconds
const { TokenMetadataExtractor: OriginalExtractor } = require('./token-metadata-extractor');

let tweetCache = {
    tweets: new Map(),
    pendingSync: new Set(),
    lastSyncToFirebase: null
};

// In-memory cache for fastest access
let communityCache = {
    communities: new Map(),
    pendingSync: new Set(),
    lastSyncToFirebase: null
};

//TWITTER FOR LOCALHOST TEST 8.25 
const { loadTwitterCookies, getTwitterHeaders } = require('./import-cookies');
//TWITTER FOR LOCALHOST TEST 8.25 

// Initialize Firebase Admin SDaK
// Initialize Firebase Admin SDzK from environment variables
const serviceAccount = {
    type: "service_account",
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL
};

// 1. SSL Configuration with Enhanced Security
const sslOptions = {
    key: fs.readFileSync(path.join(__dirname, 'ssl/devscope.fun.key')),
    cert: fs.readFileSync(path.join(__dirname, 'ssl/devscope.fun.crt')),
    ca: fs.readFileSync(path.join(__dirname, 'ssl/devscope.fun-ca.crt')),
    // Security best practices
    minVersion: 'TLSv1.2',
    ciphers: [
        'ECDHE-ECDSA-AES128-GCM-SHA256',
        'ECDHE-RSA-AES128-GCM-SHA256',
        'ECDHE-ECDSA-AES256-GCM-SHA384',
        'ECDHE-RSA-AES256-GCM-SHA384'
    ].join(':'),
    honorCipherOrder: true
};

const secondaryMatchesLogFile = path.join(__dirname, 'secondary_matches_timing.txt');

// Add this with other global tracking
// DELETE: const tokenProcessingQueue = [];
// DELETE: let isProcessingQueue = false;

let activeThreadCount = 0;
const MAX_CONCURRENT_THREADS = 50; // Safety limit

// ANSI color codes for yellow highlighting
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function logThreadStatus(action, tokenAddress) {
    console.log(`${YELLOW}${BOLD}🔀 [THREAD ${action.toUpperCase()}] ${tokenAddress.substring(0, 16)}...${RESET}`);
    console.log(`${YELLOW}📊 Active Concurrent Threads: ${activeThreadCount}${RESET}`);
}

// ========== INSTANT PARALLEL TOKEN PROCESSING ==========
async function processTokenInstantly(tokenData, platform) {
    // Safety check - prevent thread explosion
    if (activeThreadCount >= MAX_CONCURRENT_THREADS) {
        console.log(`⚠️ Max concurrent threads (${MAX_CONCURRENT_THREADS}) reached - dropping token ${tokenData.mint}`);
        return;
    }

    activeThreadCount++;
    const tokenAddress = tokenData.mint;

    logThreadStatus('started', tokenAddress);

    // Process in its own async context (parallel thread)
    (async () => {
        try {
            const startTime = Date.now();

            // Route to correct processing function
            if (botState.settings.snipeAllTokens) {
                await processTokenInstantSnipe(tokenData, platform);
            } else {
                await processNewToken(tokenData, platform);
            }

            const totalTime = Date.now() - startTime;
            console.log(`${YELLOW}✅ Thread completed in ${totalTime}ms for ${tokenAddress.substring(0, 16)}...${RESET}`);

        } catch (error) {
            console.error(`${YELLOW}❌ Thread error for ${tokenAddress.substring(0, 16)}...: ${error.message}${RESET}`);
        } finally {
            activeThreadCount--;
            logThreadStatus('ended', tokenAddress);
        }
    })();
}

function logSecondaryMatch(tokenAddress, adminName, processingTime) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] Token: ${tokenAddress} | Admin: ${adminName} | Time: ${processingTime}ms\n`;

    try {
        fs.appendFileSync(secondaryMatchesLogFile, logEntry);
        console.log(`📝 Secondary match logged: ${adminName} - ${processingTime}ms`);
    } catch (error) {
        console.error('Error writing to secondary matches log file:', error);
    }
}

function logAdminMatchTiming(tokenAddress, adminName, matchType, processingTime, browserOpenTime = null) {
    const timestamp = new Date().toISOString();
    let logEntry = `[${timestamp}] Token: ${tokenAddress} | Admin: ${adminName} | Match: ${matchType} | Detection: ${processingTime}ms`;

    if (browserOpenTime !== null) {
        logEntry += ` | BrowserOpen: ${browserOpenTime}ms`;
    }

    logEntry += '\n';

    try {
        fs.appendFileSync(path.join(__dirname, 'admin_timing_debug.txt'), logEntry);
        console.log(`🔍 Admin timing logged: ${adminName} - Detection: ${processingTime}ms${browserOpenTime ? `, Browser: ${browserOpenTime}ms` : ''}`);
    } catch (error) {
        console.error('Error writing to admin timing debug file:', error);
    }
}

// ========== COMPLETE initializeSecondaryMatchesLog FUNCTION ==========
function initializeSecondaryMatchesLog() {
    const header = `=== SECONDARY ADMIN MATCHES TIMING LOG ===\nStarted: ${new Date().toISOString()}\nFormat: [Timestamp] Token: [Address] | Admin: [Name] | Time: [ms]\n\n`;
    try {
        if (!fs.existsSync(secondaryMatchesLogFile)) {
            fs.writeFileSync(secondaryMatchesLogFile, header);
            console.log(`📝 Secondary matches timing log initialized: ${secondaryMatchesLogFile}`);
        }
    } catch (error) {
        console.error('Error initializing secondary matches log file:', error);
    }
}

function testSecondaryMatchLogging() {
    console.log('🔍 Testing secondary match logging...');
    logSecondaryMatch('TEST_TOKEN_ADDRESS_123', 'TEST_ADMIN_NAME', 1234);
    console.log('✅ Test logging completed - check secondary_matches_timing.txt file');
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL || "https://devscope-cad93-default-rtdb.firebaseio.com"
});

const db = admin.firestore();

const app = express();
const httpServer = require('http').createServer(app);
const httpsServer = https.createServer(sslOptions, app);
const openedTokens = new Set();

// Create WebSocket servers for both HTTP and HTTPS
const wss = new WebSocket.Server({ server: httpServer });
const wssSecure = new WebSocket.Server({ server: httpsServer });

function logTokenTiming(tokenAddress, tokenName, matchType, matchedEntity, processingTime, platform) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] Token: ${tokenAddress} | Name: ${tokenName || 'Unknown'} | Match: ${matchType || 'no_match'} | Entity: ${matchedEntity || 'None'} | Time: ${processingTime}ms | Platform: ${platform}\n`;

    try {
        fs.appendFileSync(timingLogFile, logEntry);
    } catch (error) {
        console.error('Error writing to timing log file:', error);
    }
}

function initializeTimingLog() {
    const header = `=== TOKEN TIMING LOG ===\nStarted: ${new Date().toISOString()}\n\n`;
    try {
        if (!fs.existsSync(timingLogFile)) {
            fs.writeFileSync(timingLogFile, header);
            console.log(`📝 Token timing log initialized: ${timingLogFile}`);
        }
    } catch (error) {
        console.error('Error initializing timing log file:', error);
    }
}

// Handle WebSocket connections for both servers
function handleWebSocketConnection(ws) {
    console.log('Client connected to WebSocket');
    wsClients.add(ws);

    ws.send(JSON.stringify({
        type: 'bot_status',
        data: { isRunning: botState.isRunning }
    }));

    ws.on('close', () => {
        console.log('Client disconnected from WebSocket');
        wsClients.delete(ws);
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        wsClients.delete(ws);
    });
}

// Apply the same handler to both WebSocket servers
wss.on('connection', handleWebSocketConnection);
wssSecure.on('connection', handleWebSocketConnection);

app.use(cors());
app.use(express.json());

// Configuration
const PORT = process.env.PORT || 3001;
const HELIUS_RPC = process.env.HELIUS_RPC;
const PUMP_PORTAL_API_KEY = process.env.PUMP_PORTAL_API_KEY;

const TWITTER_CONFIG = {
    username: process.env.TWITTER_USERNAME,
    password: process.env.TWITTER_PASSWORD,
    sessionDir: './session',
    cookiesPath: './session/twitter-cookies.json',
    sessionDurationHours: 24,
    timeouts: {
        navigation: 30000,
        selector: 10000,
        action: 5000
    }
};

function createBlueLogger() {
    return {
        log: (message) => console.log('\x1b[96m%s\x1b[0m', `🔵 ${message}`),
        logBold: (message) => console.log('\x1b[96m\x1b[1m%s\x1b[0m', `🔵 ${message}`),
        separator: () => console.log('\x1b[96m\x1b[1m%s\x1b[0m', '🔵 ═══════════════════════════════════════════════════'),
        success: (message) => console.log('\x1b[96m\x1b[1m%s\x1b[0m', `🔵 ✅ ${message}`),
        error: (message) => console.log('\x1b[96m\x1b[1m%s\x1b[0m', `🔵 ❌ ${message}`),
        warning: (message) => console.log('\x1b[96m\x1b[1m%s\x1b[0m', `🔵 ⚠️ ${message}`),
        info: (message) => console.log('\x1b[96m%s\x1b[0m', `🔵 ℹ️ ${message}`)
    };
}

function createRedLogger() {
    return {
        log: (message) => console.log('\x1b[91m%s\x1b[0m', `🔴 ${message}`),
        logBold: (message) => console.log('\x1b[91m\x1b[1m%s\x1b[0m', `🔴 ${message}`),
        separator: () => console.log('\x1b[91m\x1b[1m%s\x1b[0m', '🔴 ═══════════════════════════════════════════════════'),
        success: (message) => console.log('\x1b[91m\x1b[1m%s\x1b[0m', `🔴 ✅ ${message}`),
        error: (message) => console.log('\x1b[91m\x1b[1m%s\x1b[0m', `🔴 ❌ ${message}`),
        warning: (message) => console.log('\x1b[91m\x1b[1m%s\x1b[0m', `🔴 ⚠️ ${message}`),
        info: (message) => console.log('\x1b[91m%s\x1b[0m', `🔴 ℹ️ ${message}`),
        matchFound: (adminName, matchType, tokenInfo) => {
            console.log('\x1b[91m\x1b[1m%s\x1b[0m', '\n' + '🔴 '.repeat(50));
            console.log('\x1b[91m\x1b[1m%s\x1b[0m', '🔴 ╔═══════════════════════════════════════════════════╗');
            console.log('\x1b[91m\x1b[1m%s\x1b[0m', '🔴 ║   PRIMARY ADMIN MATCH DETECTED - AUTO-SNIPING!   ║');
            console.log('\x1b[91m\x1b[1m%s\x1b[0m', '🔴 ╚═══════════════════════════════════════════════════╝');
            console.log('\x1b[91m\x1b[1m%s\x1b[0m', `🔴 MATCHED ADMIN: ${adminName}`);
            console.log('\x1b[91m\x1b[1m%s\x1b[0m', `🔴 MATCH TYPE: ${matchType}`);
            console.log('\x1b[91m\x1b[1m%s\x1b[0m', `🔴 TOKEN: ${tokenInfo.name} (${tokenInfo.symbol})`);
            console.log('\x1b[91m\x1b[1m%s\x1b[0m', `🔴 ADDRESS: ${tokenInfo.address}`);
            console.log('\x1b[91m\x1b[1m%s\x1b[0m', `🔴 PLATFORM: ${tokenInfo.platform}`);
            console.log('\x1b[91m\x1b[1m%s\x1b[0m', '🔴 '.repeat(50) + '\n');
        }
    };
}

const primaryMatchesLogFile = path.join(__dirname, 'primary_matches_timing.txt');

function logPrimaryMatch(tokenAddress, adminName, matchType, processingTime, detectionMethod) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] 🔴 PRIMARY MATCH | Token: ${tokenAddress} | Admin: ${adminName} | Type: ${matchType} | Method: ${detectionMethod} | Time: ${processingTime}ms\n`;

    try {
        fs.appendFileSync(primaryMatchesLogFile, logEntry);
        console.log(`🔴 Primary match logged: ${adminName} - ${processingTime}ms - ${detectionMethod}`);
    } catch (error) {
        console.error('Error writing to primary matches log file:', error);
    }
}

function initializePrimaryMatchesLog() {
    const header = `=== PRIMARY ADMIN MATCHES TIMING LOG ===\nStarted: ${new Date().toISOString()}\nFormat: [Timestamp] Token: [Address] | Admin: [Name] | Type: [Match Type] | Method: [Detection Method] | Time: [ms]\n\n`;
    try {
        if (!fs.existsSync(primaryMatchesLogFile)) {
            fs.writeFileSync(primaryMatchesLogFile, header);
            console.log(`🔴 Primary matches timing log initialized: ${primaryMatchesLogFile}`);
        }
    } catch (error) {
        console.error('Error initializing primary matches log file:', error);
    }
}

const connection = new Connection(HELIUS_RPC, {
    commitment: 'processed',
    confirmTransactionInitialTimeout: 30000,
});

const IPFS_GATEWAYS = [
    'https://cloudflare-ipfs.com/ipfs/',
    'https://gateway.pinata.cloud/ipfs/',
    'https://nftstorage.link/ipfs/',
    'https://4everland.io/ipfs/',
    'https://dweb.link/ipfs/',
];

const GATEWAY_TIMEOUT = 3000;

function extractIPFSHash(url) {
    const match = url.match(/\/ipfs\/([a-zA-Z0-9]+)/);
    return match ? match[1] : null;
}

/**
 * Fetch IPFS data using gateway racing
 * @param {string} ipfsUrl - Original IPFS URL (e.g., https://ipfs.io/ipfs/bafkreic...)
 * @returns {Promise<object|null>} - Parsed JSON data or null
 */
async function fetchIPFSFastest(ipfsUrl) {
    const hash = extractIPFSHash(ipfsUrl);

    if (!hash) {
        console.error('❌ Invalid IPFS URL:', ipfsUrl);
        return null;
    }

    console.log(`🏁 Racing ${IPFS_GATEWAYS.length} gateways for: ${hash.substring(0, 12)}...`);
    const startTime = Date.now();

    return new Promise((resolve) => {
        let resolved = false;
        let completedCount = 0;
        const errors = [];

        // Launch all gateway requests simultaneously
        IPFS_GATEWAYS.forEach((gateway, index) => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT);

            fetch(`${gateway}${hash}`, {
                signal: controller.signal,
                headers: { 'Accept': 'application/json' },
            })
                .then(async (response) => {
                    clearTimeout(timeoutId);

                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }

                    const data = await response.json();

                    // First successful response wins!
                    if (!resolved) {
                        resolved = true;
                        const duration = Date.now() - startTime;
                        console.log(`✅ Winner: Gateway #${index + 1} (${gateway.split('/')[2]}) - ${duration}ms`);
                        resolve(data);
                    }
                })
                .catch((error) => {
                    clearTimeout(timeoutId);

                    const errorMsg = error.name === 'AbortError'
                        ? 'Timeout'
                        : error.message;

                    errors.push(`Gateway #${index + 1}: ${errorMsg}`);
                    completedCount++;

                    // All gateways failed
                    if (completedCount === IPFS_GATEWAYS.length && !resolved) {
                        resolved = true;
                        console.error(`❌ All gateways failed for ${hash.substring(0, 12)}...`);
                        console.error('Errors:', errors);
                        resolve(null);
                    }
                });
        });
    });
}

async function processToken(token) {
    const ipfsUrl = token.metadata?.uri; // From Pump.fun WebSocket

    if (!ipfsUrl || !ipfsUrl.includes('ipfs')) {
        console.log('⚠️ No IPFS URL found');
        return null;
    }

    // This will now take 200-800ms instead of 5000ms!
    const metadata = await fetchIPFSFastest(ipfsUrl);

    if (!metadata) {
        console.log('❌ Failed to fetch metadata from all gateways');
        return null;
    }

    console.log('📦 Metadata:', {
        name: metadata.name,
        symbol: metadata.symbol,
        description: metadata.description?.substring(0, 50) + '...',
    });

    return metadata;
}

const DEMO_TOKEN_TEMPLATES = [
    {
        name: "Macaroni Mouse",
        symbol: "MACARONI",
        uri: "https://eu-dev.uxento.io/data/cmdvcbd2n00jghb190aiy0y8r",
        pool: "bonk",
        platform: "letsbonk",
        twitterHandle: "Rainmaker1973"
    },
    {
        name: "BuuCoin",
        symbol: "MAJINBUU",
        uri: "https://ipfs.io/ipfs/QmTGkzD267qcG32NvyAhxgijxvhtsbRaPUx7WJMNHZDY35",
        pool: "pump",
        platform: "pumpfun",
        twitterHandle: "CryptoMajin"
    },
    {
        name: "Doge Supreme",
        symbol: "DSUP",
        uri: "https://ipfs.io/ipfs/QmSampleDogeImage123",
        pool: "pump",
        platform: "pumpfun",
        twitterHandle: "DogeSupremeTeam"
    },
    {
        name: "Moon Cat",
        symbol: "MCAT",
        uri: "https://ipfs.io/ipfs/QmSampleCatImage456",
        pool: "bonk",
        platform: "letsbonk",
        twitterHandle: "MoonCatOfficial"
    }
];

// Demo wallet addresses for testing
const DEMO_WALLETS = [
    "HaSdFi2wKLTguxuh4PMBgZuAscbMGEF8XnMHgD5vUeGr",
    "HJdauMU7e8tmM7NFDjV9BSoVzZobVS88wnp3TDAfjuE",
    "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
    "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
];

// ========== FIREBASE HELPER FUNCTIONS ==========

async function saveAdminListToFirebase(listType, adminData) {
    try {
        console.log(`🔥 Saving ${listType} to Firebase:`, adminData);

        const docRef = db.collection(listType).doc(adminData.id);
        await docRef.set({
            ...adminData,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`✅ SUCCESS: ${listType} entry ${adminData.id} saved to Firebase`);
        return true;
    } catch (error) {
        console.error(`❌ ERROR saving ${listType} to Firebase:`, error);
        return false;
    }
}

async function loadAdminListFromFirebase(listType) {
    try {
        console.log(`📥 Loading ${listType} from Firebase`);

        const snapshot = await db.collection(listType).orderBy('createdAt', 'desc').get();
        const adminList = [];

        snapshot.forEach(doc => {
            adminList.push({
                id: doc.id,
                ...doc.data()
            });
        });

        console.log(`✅ Loaded ${adminList.length} entries from Firebase ${listType}`);
        return adminList;
    } catch (error) {
        console.error(`❌ ERROR loading ${listType} from Firebase:`, error);
        return [];
    }
}

async function deleteAdminFromFirebase(listType, adminId) {
    try {
        console.log(`🗑️ Deleting ${adminId} from Firebase ${listType}`);

        await db.collection(listType).doc(adminId).delete();

        console.log(`✅ SUCCESS: ${adminId} deleted from Firebase ${listType}`);
        return true;
    } catch (error) {
        console.error(`❌ ERROR deleting ${adminId} from Firebase ${listType}:`, error);
        return false;
    }
}

const SOUNDS_DIR = path.join(__dirname, 'uploads', 'sounds');

const ADMIN_CACHE_FILE = path.join(__dirname, 'admin_cache.json');

async function saveAdminListsToFile() {
    try {
        const adminData = {
            primary_admins: Array.from(botState.primaryAdminList.values()),
            secondary_admins: Array.from(botState.secondaryAdminList.values()),
            lastUpdated: new Date().toISOString(),
            version: "1.0"
        };

        await fsPromises.writeFile(ADMIN_CACHE_FILE, JSON.stringify(adminData, null, 2));
        console.log(`💾 Admin lists saved to file: ${ADMIN_CACHE_FILE}`);
        return true;
    } catch (error) {
        console.error('❌ Error saving admin lists to file:', error);
        return false;
    }
}

// Add this function to load admin lists from JSON file
async function loadAdminListsFromFile() {
    try {
        if (!fs.existsSync(ADMIN_CACHE_FILE)) {
            console.log('📄 Admin cache file not found');
            return { primary_admins: [], secondary_admins: [] };
        }

        const fileContent = await fsPromises.readFile(ADMIN_CACHE_FILE, 'utf8');
        const adminData = JSON.parse(fileContent);

        console.log(`📄 Loaded admin lists from file: ${adminData.lastUpdated}`);
        console.log(`   Primary: ${adminData.primary_admins?.length || 0} entries`);
        console.log(`   Secondary: ${adminData.secondary_admins?.length || 0} entries`);

        return adminData;
    } catch (error) {
        console.error('❌ Error loading admin lists from file:', error);
        return { primary_admins: [], secondary_admins: [] };
    }
}

// Ensure sounds directory exists
async function ensureSoundsDir() {
    try {
        await fsPromises.mkdir(SOUNDS_DIR, { recursive: true });
        console.log('📁 Sounds directory created/verified');
    } catch (error) {
        console.error('Error creating sounds directory:', error);
    }
}

// Configure multer for sound uploads
const soundStorage = multer.diskStorage({
    destination: async (req, file, cb) => {
        await ensureSoundsDir();
        cb(null, SOUNDS_DIR);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, `sound-${uniqueSuffix}${ext}`);
    }
});

const uploadSound = multer({
    storage: soundStorage,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    },
    fileFilter: (req, file, cb) => {
        const allowedMimes = [
            'audio/wav', 'audio/wave', 'audio/x-wav',
            'audio/mpeg', 'audio/mp3',
            'audio/ogg', 'audio/vorbis',
            'audio/mp4', 'audio/m4a', 'audio/x-m4a'
        ];

        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only audio files are allowed.'), false);
        }
    }
});

// Helper function to determine MIME type
function getMimeType(ext) {
    const mimeTypes = {
        '.wav': 'audio/wav',
        '.mp3': 'audio/mpeg',
        '.ogg': 'audio/ogg',
        '.m4a': 'audio/m4a'
    };
    return mimeTypes[ext.toLowerCase()] || 'audio/unknown';
}

// ========== ORIGINAL BOTSTATE CLASS ==========

// ADD THIS TWITTER SCRAPER CLASS
class TwitterCommunityAdminScraper {
    constructor() {
        this.browser = null;
        this.context = null;
        this.page = null;
        this.sessionActive = false;
        this.isInitialized = false;
        this.sessionPersistentDataDir = './session/twitter-session';
        this.responseHandler = null;
    }

    async init() {
        if (this.isInitialized) return true;

        try {
            console.log('🤖 Initializing Twitter scraper with persistent session...');
            await this.ensureDirectories();
            const userAgent = new UserAgent({ deviceCategory: 'desktop' });

            // ✅ FIXED: launchPersistentContext returns BrowserContext, not Browser
            this.browser = await chromium.launchPersistentContext(this.sessionPersistentDataDir, {
                headless: true,
                userAgent: userAgent.toString(),
                viewport: { width: 1366, height: 768 },
                args: [
                    '--no-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-web-security',
                    '--disable-features=VizDisplayCompositor',
                    '--disable-extensions',
                    '--no-first-run',
                    '--disable-default-apps'
                ]
            });

            // ✅ FIXED: Get page from the context correctly
            const pages = this.browser.pages();
            this.page = pages[0] || await this.browser.newPage();

            this.isInitialized = true;
            console.log('✅ Twitter scraper initialized with persistent session');
            return true;
        } catch (error) {
            console.error('❌ Failed to initialize Twitter scraper:', error);
            return false;
        }
    }

    // Add this method to TwitterCommunityAdminScraper class (around line 350)

    /*
    Main Changes:
    
    Added cookie loading functionality:
    javascriptconst cookies = loadTwitterCookies(); // NEW - loads cookies from your import
    
    Added cookie injection into browser:
    javascriptawait this.page.context().addCookies(cookies); // NEW - applies cookies to browser
    */

    async automaticLogin() {
        try {
            console.log('🍪 Loading imported Twitter session from cookies...');

            // Load cookies using the import-cookies helper
            const cookies = loadTwitterCookies();

            if (cookies && cookies.length > 0) {
                // Add cookies to the browser context
                await this.page.context().addCookies(cookies);
                console.log(`✅ Loaded ${cookies.length} cookies from imported session`);

                // Navigate to Twitter home to verify session
                await this.page.goto('https://twitter.com/home', {
                    waitUntil: 'domcontentloaded',
                    timeout: 15000
                });

                await this.page.waitForTimeout(3000);

                // Check if we're logged in
                const currentUrl = this.page.url();
                console.log(`🔍 Current URL after cookie load: ${currentUrl}`);

                // Check login indicators
                const loginIndicators = await this.page.evaluate(() => {
                    const indicators = {
                        notOnLoginPage: !window.location.href.includes('/login') && !window.location.href.includes('/i/flow/login'),
                        onHomePage: window.location.href.includes('/home'),
                        hasNavigation: !!document.querySelector('[data-testid="SideNav_NewTweet_Button"]') ||
                            !!document.querySelector('[aria-label="Home timeline"]') ||
                            !!document.querySelector('[data-testid="primaryColumn"]'),
                        hasUserAvatar: !!document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')
                    };
                    return indicators;
                });

                console.log('🔍 Login indicators:', loginIndicators);

                if (loginIndicators.notOnLoginPage && loginIndicators.onHomePage) {
                    console.log('✅ Session restored successfully using imported cookies');
                    this.sessionActive = true;

                    // Double-check by calling checkSessionStatus
                    const statusCheck = await this.checkSessionStatus();
                    if (statusCheck.loggedIn) {
                        return true;
                    }
                }
            } else {
                console.log('❌ No cookies found, trying traditional login...');
                return await this.fallbackLogin();
            }

        } catch (error) {
            console.error('❌ Session restore failed:', error.message);
            console.log('⚠️ Falling back to traditional login...');
            return await this.fallbackLogin();
        }
    }

    async scrapeCommunityAdminsBrowser(communityId) {
        const startTime = Date.now();
        const TIMEOUT_MS = 3000;
        console.log(`🎯 BROWSER FALLBACK: Community ${communityId} (${TIMEOUT_MS}ms timeout)`);

        try {
            const moderatorsUrl = `https://x.com/i/communities/${communityId}/moderators`;

            await this.page.goto(moderatorsUrl, {
                waitUntil: 'domcontentloaded',
                timeout: TIMEOUT_MS
            });

            const currentUrl = this.page.url();
            if (currentUrl.includes('login') || currentUrl.includes('/i/flow/login')) {
                console.log('❌ Session expired - redirected to login');
                throw new Error('Session expired. Please login manually again.');
            }

            console.log('🎯 ATTEMPTING API INTERCEPTION...');
            const apiAdmins = await this.extractAdminsFromApi(communityId);

            if (apiAdmins && apiAdmins.length > 0) {
                console.log(`✅ API INTERCEPTION SUCCESS: Found ${apiAdmins.length} admin(s)`);
                return apiAdmins;
            }

            console.log('⚠️ API INTERCEPTION FAILED: Falling back to DOM scraping...');
            await this.page.waitForTimeout(1000);

            const adminData = await this.extractAdminsFromDOM();
            console.log(`✅ BROWSER SCRAPING COMPLETED: Found ${adminData.length} admin(s) in ${Date.now() - startTime}ms`);
            return adminData;

        } catch (error) {
            console.error('❌ Browser scraping failed:', error);
            return [];
        }
    }

    async fallbackLogin() {
        // Your existing login code as fallback
        try {
            console.log('🔐 Attempting traditional login...');

            await this.page.goto('https://twitter.com/login', {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });

            await this.page.waitForTimeout(2000);

            // Fill username
            await this.page.fill('input[name="text"]', TWITTER_CONFIG.username);
            await this.page.press('input[name="text"]', 'Enter');

            await this.page.waitForTimeout(3000);

            // Fill password
            await this.page.fill('input[name="password"]', TWITTER_CONFIG.password);
            await this.page.press('input[name="password"]', 'Enter');

            // Wait for any redirect and check success more reliably
            await this.page.waitForTimeout(5000);

            const finalUrl = this.page.url();
            if (!finalUrl.includes('/login') && !finalUrl.includes('/i/flow/login')) {
                console.log('✅ Traditional login successful');
                this.sessionActive = true;
                return true;
            } else {
                console.log('❌ Traditional login failed');
                return false;
            }

        } catch (error) {
            console.error('❌ Traditional login failed:', error.message);
            return false;
        }
    }

    async ensureDirectories() {
        try {
            await fsPromises.access('./session');
        } catch {
            await fsPromises.mkdir('./session', { recursive: true });
        }

        try {
            await fsPromises.access(this.sessionPersistentDataDir);
        } catch {
            await fsPromises.mkdir(this.sessionPersistentDataDir, { recursive: true });
        }
    }

    async checkSessionStatus() {
        if (!this.page) {
            return { loggedIn: false, error: 'Browser not initialized' };
        }

        try {
            const currentUrl = this.page.url();
            console.log(`🔍 Current page URL: ${currentUrl}`);

            // If we're on login page, definitely not logged in
            if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login')) {
                console.log('❌ On login page - not logged in');
                this.sessionActive = false;
                return { loggedIn: false, url: currentUrl };
            }

            // If we're on home page or any other x.com page (not login), we're logged in
            if (currentUrl.includes('x.com/home') || currentUrl.includes('twitter.com/home')) {
                console.log('✅ On home page - logged in');
                this.sessionActive = true;
                return {
                    loggedIn: true,
                    url: currentUrl,
                    method: 'home_page_url'
                };
            }

            // Additional check - wait a bit for page to load
            await this.page.waitForTimeout(2000);

            // Check for logged-in indicators with multiple strategies
            const loggedInCheck = await this.page.evaluate(() => {
                // Check if we're NOT on login page
                const notOnLogin = !window.location.href.includes('/login') &&
                    !window.location.href.includes('/i/flow/login');

                // Check if we're on home or another authenticated page
                const onHome = window.location.href.includes('/home');

                // If we're on home and not on login, we're logged in
                if (notOnLogin && onHome) {
                    return { method: 'url_check', loggedIn: true };
                }

                // Look for any Twitter navigation elements (they change frequently)
                const hasAnyTwitterElement =
                    !!document.querySelector('[data-testid*="Nav"]') ||
                    !!document.querySelector('[aria-label*="Home"]') ||
                    !!document.querySelector('[role="navigation"]') ||
                    !!document.querySelector('nav');

                if (notOnLogin && hasAnyTwitterElement) {
                    return { method: 'navigation_elements', loggedIn: true };
                }

                // If we're not on login page, assume logged in
                if (notOnLogin) {
                    return { method: 'not_on_login', loggedIn: true };
                }

                return { method: 'default', loggedIn: false };
            });

            console.log(`🔍 Session check result:`, loggedInCheck);

            this.sessionActive = loggedInCheck.loggedIn;
            return {
                loggedIn: loggedInCheck.loggedIn,
                url: currentUrl,
                method: loggedInCheck.method
            };

        } catch (error) {
            console.error('❌ Error checking session status:', error);
            this.sessionActive = false;
            return { loggedIn: false, error: error.message };
        }
    }

    async setupApiInterception() {
        // No longer needed - handler setup moved to extractAdminsFromApi
        return;
    }

    async extractAdminsFromApi(communityId) {
        try {
            const apiAdmins = [];
            let apiResponseReceived = false;

            // Create the response handler function (not as arrow function property)
            const responseHandler = async (response) => {
                const url = response.url();

                if (url.includes('communities') &&
                    (url.includes('moderators') || url.includes('members') || url.includes('users')) &&
                    response.status() === 200) {

                    try {
                        const data = await response.json();
                        apiResponseReceived = true;

                        // Handle different API response formats
                        if (data.users) {
                            data.users.forEach(user => {
                                if (user.role === 'admin' || user.role === 'moderator' || user.is_admin) {
                                    apiAdmins.push({
                                        username: user.screen_name || user.username,
                                        badgeType: user.role === 'admin' ? 'Admin' : 'Mod',
                                        source: 'api_interception'
                                    });
                                }
                            });
                        }

                        // Alternative response format
                        if (data.data && data.data.community && data.data.community.moderators) {
                            data.data.community.moderators.forEach(mod => {
                                if (mod.role === 'admin' || mod.role === 'moderator') {
                                    apiAdmins.push({
                                        username: mod.screen_name || mod.username,
                                        badgeType: mod.role === 'admin' ? 'Admin' : 'Mod',
                                        source: 'api_interception'
                                    });
                                }
                            });
                        }
                    } catch (e) {
                        // JSON parsing failed
                    }
                }
            };

            // Add the response listener
            this.page.on('response', responseHandler);

            // Navigate to the page
            await this.page.goto(`https://x.com/i/communities/${communityId}/moderators`, {
                waitUntil: 'domcontentloaded',
                timeout: 8000
            });

            await this.page.waitForTimeout(1500);

            // Remove the listener
            this.page.off('response', responseHandler);

            if (apiAdmins.length > 0) {
                console.log(`🎯 API interception found ${apiAdmins.length} admin(s)`);
                return apiAdmins;
            }

            return null;

        } catch (error) {
            console.log('API interception failed:', error.message);
            return null;
        }
    }

    async openLoginPage() {
        if (!this.page) {
            throw new Error('Browser not initialized');
        }

        try {
            console.log('🔗 Opening Twitter login page for manual login...');
            await this.page.goto('https://twitter.com/login');
            console.log('✅ Twitter login page opened - admin can now login manually');
            return true;
        } catch (error) {
            console.error('❌ Failed to open login page:', error);
            return false;
        }
    }

    async scrapeCommunityAdmins(communityId) {
        console.log(`🚀 API SCRAPING: Community ${communityId} (replacing browser scraping)`);

        try {
            // ✅ STEP 3A: Use twitterapi.io API instead of browser scraping
            const members = await twitterAPI.getAllCommunityModerators(communityId);

            // ✅ STEP 3B: Transform API response to match your existing format
            // Based on twitterapi.io response structure: userName, name, id, isBlueVerified, etc.
            const transformedAdmins = members.map(member => ({
                username: member.userName,           // ✅ CONFIRMED: "userName" from API docs
                displayName: member.name,            // ✅ CONFIRMED: "name" from API docs
                id: member.id,                       // ✅ CONFIRMED: "id" from API docs
                badgeType: 'Admin',                  // Treat all community members as admins
                source: 'twitter_api',               // Mark as API source
                verified: member.isBlueVerified,     // ✅ CONFIRMED: "isBlueVerified" from API docs
                followers: member.followers,         // ✅ CONFIRMED: "followers" from API docs
                following: member.following,         // ✅ CONFIRMED: "following" from API docs
                location: member.location,           // ✅ CONFIRMED: "location" from API docs
                description: member.description,     // ✅ CONFIRMED: "description" from API docs
                url: member.url,                     // ✅ CONFIRMED: "url" from API docs
                profileImage: member.profilePicture, // ✅ CONFIRMED: "profilePicture" from API docs
                profileBanner: member.coverPicture,  // ✅ CONFIRMED: "coverPicture" from API docs
                canDM: member.canDm,                 // ✅ CONFIRMED: "canDm" from API docs
                protected: false,                    // Not available in twitterapi.io response
                createdAt: member.createdAt,         // ✅ CONFIRMED: "createdAt" from API docs
                favouritesCount: member.favouritesCount, // ✅ CONFIRMED: "favouritesCount" from API docs
                statusesCount: member.statusesCount, // ✅ CONFIRMED: "statusesCount" from API docs
                mediaCount: member.mediaCount        // ✅ CONFIRMED: "mediaCount" from API docs
            }));

            console.log(`✅ API TRANSFORMATION: Converted ${transformedAdmins.length} members to admin format`);

            // ✅ STEP 3C: Filter out invalid usernames (keep your existing validation)
            const validAdmins = transformedAdmins.filter(admin => {
                if (!admin.username || admin.username.length < 1) return false;
                return this.isValidUsernameFast(admin.username);
            });

            console.log(`✅ VALIDATION: ${validAdmins.length} valid admins after filtering`);
            return validAdmins;

        } catch (error) {
            console.error('❌ API scraping failed, using only unofficial twitter api', error);

            // ✅ STEP 3D: Fallback to original browser scraping if API fails
            // return await this.scrapeCommunityAdminsBrowser(communityId);
        }
    }


    // 🚀 FAST USERNAME VALIDATION
    isValidUsernameFast(username) {
        if (!username || username.length < 2 || username.length > 15) return false;
        if (!/^[a-zA-Z0-9_]+$/.test(username)) return false;
        const blockedTerms = ['home', 'explore', 'messages', 'follow', 'click', 'search', 'notifications', 'profile', 'settings', 'logout', 'help', 'about', 'privacy', 'terms'];
        if (blockedTerms.includes(username.toLowerCase())) return false;
        return true;
    }

    // Keep your existing parseAdminsFromText for backward compatibility
    parseAdminsFromText(pageText) {
        const admins = [];
        const foundUsernames = new Set(); // Prevent duplicates
        console.log('🔍 Analyzing text for admin patterns...');

        // Helper function to validate usernames and exclude generic terms
        const isValidUsername = (username) => {
            const excludeList = ['admin', 'mod', 'moderator', 'moderators', 'allmoderators',
                'members', 'follow', 'click', 'show', 'more', 'terms', 'privacy', 'cookie',
                'home', 'explore', 'messages'];

            return username &&
                /^[a-zA-Z0-9_]{1,15}$/.test(username) &&
                !excludeList.includes(username.toLowerCase()) &&
                username.length > 2;
        };

        // Split text into words for easier processing
        const words = pageText.split(/\s+/);

        for (let i = 0; i < words.length; i++) {
            const word = words[i];
            const nextWord = words[i + 1] || '';

            // Pattern 1: "Username Admin" or "Username Mod"
            if (nextWord === 'Admin' || nextWord === 'Mod') {
                const username = word.replace(/[^a-zA-Z0-9_]/g, '');
                if (isValidUsername(username) && !foundUsernames.has(username.toLowerCase())) {
                    admins.push({
                        username: username,
                        badgeType: nextWord,
                        source: 'text_analysis',
                        pattern: 'username_before_badge'
                    });
                    foundUsernames.add(username.toLowerCase());
                    console.log(`👑 FOUND ${nextWord.toUpperCase()}: ${username}`);

                    // Early exit after finding first valid admin/mod
                    break;
                }
            }

            // Pattern 2: "@username" with nearby admin/mod indicators
            if (word.startsWith('@')) {
                const username = word.substring(1).replace(/[^a-zA-Z0-9_]/g, '');
                if (isValidUsername(username) && !foundUsernames.has(username.toLowerCase())) {
                    const nearbyWords = [
                        words[i - 2], words[i - 1], words[i + 1], words[i + 2]
                    ].filter(w => w).join(' ');

                    let badgeType = null;
                    if (nearbyWords.includes('Admin')) badgeType = 'Admin';
                    else if (nearbyWords.includes('Mod')) badgeType = 'Mod';

                    if (badgeType) {
                        admins.push({
                            username: username,
                            badgeType: badgeType,
                            source: 'text_analysis',
                            pattern: '@username_near_badge'
                        });
                        foundUsernames.add(username.toLowerCase());
                        console.log(`👑 FOUND ${badgeType.toUpperCase()}: ${username}`);

                        // Early exit after finding first valid admin/mod
                        break;
                    }
                }
            }

            // Pattern 3: "Admin@username" or "Mod@username"
            if ((word.includes('Admin@') || word.includes('Mod@')) && admins.length === 0) {
                let badgeType = word.includes('Admin@') ? 'Admin' : 'Mod';
                let startPattern = badgeType + '@';

                const startIndex = word.indexOf(startPattern);
                if (startIndex !== -1) {
                    const afterAt = word.substring(startIndex + startPattern.length);
                    let username;

                    if (afterAt.includes('FollowClick')) {
                        username = afterAt.substring(0, afterAt.indexOf('FollowClick'));
                    } else {
                        const usernameMatch = afterAt.match(/^([a-zA-Z0-9_]+)/);
                        username = usernameMatch ? usernameMatch[1] : '';
                    }

                    if (isValidUsername(username) && !foundUsernames.has(username.toLowerCase())) {
                        admins.push({
                            username: username,
                            badgeType: badgeType,
                            source: 'text_analysis',
                            pattern: 'badge@username'
                        });
                        foundUsernames.add(username.toLowerCase());
                        console.log(`👑 FOUND ${badgeType.toUpperCase()}: ${username}`);

                        // Early exit after finding first valid admin/mod
                        break;
                    }
                }
            }

            // Early exit if we found a valid admin/mod
            if (admins.length > 0) break;
        }

        console.log(`🎯 PARSING RESULT: ${admins.length} valid admin(s) found`);
        admins.forEach((admin, index) => {
            console.log(`   ${index + 1}. @${admin.username} (${admin.badgeType})`);
        });

        return admins;
    }

    async extractAdminsFromScreenshot(communityId) {
        console.log('🔸 DIRECT DOM ELEMENT INSPECTION...');

        try {
            // Wait for page to load completely
            await this.page.waitForLoadState('networkidle', { timeout: 10000 });

            // Wait a bit more for dynamic content
            await this.page.waitForTimeout(3000);

            // Direct DOM inspection - exactly like browser dev tools
            const admins = await this.page.evaluate(() => {
                const results = [];

                // Method 1: Look for UserCell components (most reliable)
                const userCells = document.querySelectorAll('[data-testid="UserCell"]');
                console.log(`Found ${userCells.length} UserCell elements`);

                userCells.forEach((cell, index) => {
                    try {
                        // Get username from link
                        const usernameLink = cell.querySelector('a[href^="/"]');
                        if (usernameLink) {
                            const href = usernameLink.getAttribute('href');
                            const username = href.replace('/', '');

                            // Look for admin/mod badges in this cell
                            const cellText = cell.textContent || cell.innerText || '';

                            let badgeType = 'Member';
                            if (cellText.includes('Admin')) {
                                badgeType = 'Admin';
                            } else if (cellText.includes('Mod')) {
                                badgeType = 'Mod';
                            }

                            if (username && username.length > 0) {
                                results.push({
                                    username: username,
                                    badgeType: badgeType,
                                    source: 'direct_dom_usercell',
                                    cellText: cellText.substring(0, 100) // Debug info
                                });
                                console.log(`Found user: ${username} (${badgeType})`);
                            }
                        }
                    } catch (e) {
                        console.log(`Error processing UserCell ${index}:`, e.message);
                    }
                });

                // Method 2: Look for any links that look like usernames
                if (results.length === 0) {
                    const allLinks = document.querySelectorAll('a[href^="/"]');
                    console.log(`Fallback: Found ${allLinks.length} profile links`);

                    allLinks.forEach((link, index) => {
                        try {
                            const href = link.getAttribute('href');
                            const username = href.replace('/', '');

                            // Skip obvious non-usernames
                            if (username.includes('/') || username.length < 2 || username.length > 20) {
                                return;
                            }

                            // Look for admin/mod indicators near this link
                            const parent = link.closest('[role="listitem"], div, article');
                            if (parent) {
                                const parentText = parent.textContent || parent.innerText || '';

                                let badgeType = 'Member';
                                if (parentText.includes('Admin')) {
                                    badgeType = 'Admin';
                                } else if (parentText.includes('Mod')) {
                                    badgeType = 'Mod';
                                }

                                results.push({
                                    username: username,
                                    badgeType: badgeType,
                                    source: 'direct_dom_links',
                                    parentText: parentText.substring(0, 100) // Debug info
                                });
                                console.log(`Fallback found: ${username} (${badgeType})`);
                            }
                        } catch (e) {
                            console.log(`Error processing link ${index}:`, e.message);
                        }
                    });
                }

                // Method 3: Raw text scanning as last resort
                if (results.length === 0) {
                    const pageText = document.body.textContent || document.body.innerText || '';
                    console.log(`Final fallback: scanning ${pageText.length} characters of text`);
                    console.log(`Page text preview: "${pageText.substring(0, 200)}"`);
                }

                return results;
            });

            console.log(`✅ Direct DOM inspection completed! Found ${admins.length} admin(s)`);
            return admins;

        } catch (error) {
            console.error('❌ Direct DOM inspection failed:', error.message);
            return [];
        }
    }

    async debugPageStructure() {
        const elementCount = await this.page.evaluate(() => {
            return {
                userCells: document.querySelectorAll('[data-testid="UserCell"]').length,
                allLinks: document.querySelectorAll('a').length,
                listItems: document.querySelectorAll('[role="listitem"]').length,
                divs: document.querySelectorAll('div').length,
                bodyText: document.body.textContent.length
            };
        });

        console.log('Page structure:', elementCount);
        return elementCount;
    }

    async debugCurrentPage() {
        const url = this.page.url();
        const title = await this.page.title();
        console.log(`🔍 Current URL: ${url}`);
        console.log(`🔍 Page title: "${title}"`);

        // Check if we're redirected or blocked
        if (url.includes('login') || url.includes('suspended') || title.includes('suspended')) {
            console.log('❌ Redirected to login or suspended page');
            return false;
        }

        return true;
    }

    async extractAdminsFromDOM() {
        // ... your existing code unchanged
        console.log('🔧 Using DOM scraping (backup method)...');

        return await this.page.evaluate(() => {
            const userCells = document.querySelectorAll('div[data-testid="UserCell"]');
            const adminData = [];

            userCells.forEach((cell) => {
                const usernameLink = cell.querySelector('a[href^="/"]');

                if (usernameLink) {
                    const username = usernameLink.getAttribute('href').slice(1);

                    const adminBadge = Array.from(cell.querySelectorAll('*')).find(el =>
                        el.textContent && el.textContent.trim() === 'Admin'
                    );

                    const modBadge = Array.from(cell.querySelectorAll('*')).find(el =>
                        el.textContent && el.textContent.trim() === 'Mod'
                    );

                    let badgeType = 'Member';
                    if (adminBadge) {
                        badgeType = 'Admin';
                    } else if (modBadge) {
                        badgeType = 'Mod';
                    }

                    adminData.push({
                        username: username,
                        badgeType: badgeType,
                        source: 'dom_scraping',
                        pattern: 'html_element'
                    });
                }
            });

            return adminData;
        });
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
            this.isInitialized = false;
        }
    }

    async ensureOutputDirectory() {
        try {
            await fsPromises.access('./output');
        } catch {
            await fsPromises.mkdir('./output', { recursive: true });
            console.log('📁 Created output directory');
        }
    }

    async saveTextFile(filePath, content) {
        try {
            await fsPromises.writeFile(filePath, content, 'utf8');
            console.log(`📝 Text saved: ${filePath}`);
        } catch (error) {
            console.error('❌ Failed to save text file:', error);
        }
    }



    // 🚀 FAST USERNAME VALIDATION
    isValidUsernameFast(username) {
        if (!username || username.length < 2 || username.length > 15) return false;

        // Fast regex check - only alphanumeric and underscore
        if (!/^[a-zA-Z0-9_]+$/.test(username)) return false;

        // Block common unwanted terms
        const blockedTerms = ['home', 'explore', 'messages', 'follow', 'click', 'search', 'notifications', 'profile', 'settings', 'logout', 'help', 'about', 'privacy', 'terms'];
        if (blockedTerms.includes(username.toLowerCase())) return false;

        return true;
    }
}

class TwitterAPI {
    constructor() {
        this.apiKey = process.env.TWITTER_API_KEY; // Your API key
        this.baseURL = 'https://api.twitterapi.io'; // twitterapi.io base URL

        if (!this.apiKey) {
            throw new Error('Twitter API key not found in environment variables');
        }

        console.log(`🔑 Twitter API initialized with key: ${this.apiKey.substring(0, 10)}...`);
        console.log(`🌐 Base URL: ${this.baseURL}`);
    }

    /**
     * Fetch community moderators using twitterapi.io
     * Based on your API response structure with "moderators" array
     */
    async getCommunityModerators(communityId, cursor = null) {
        try {
            console.log(`🎯 API CALL: Fetching moderators for community ${communityId}`);

            // ✅ CORRECT ENDPOINT: /twitter/community/moderators
            const url = new URL(`${this.baseURL}/twitter/community/moderators`);
            url.searchParams.append('community_id', communityId);

            if (cursor) {
                url.searchParams.append('cursor', cursor);
            }

            const response = await fetch(url.toString(), {
                method: 'GET',
                headers: {
                    'X-API-Key': this.apiKey,
                    'Content-Type': 'application/json'
                },
                timeout: 15000 // 15 second timeout
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API request failed: ${response.status} ${response.statusText} - ${errorText}`);
            }

            const data = await response.json();

            // ✅ FIXED: Your API returns "moderators" array, not "members"
            console.log(`✅ API SUCCESS: Found ${data.moderators?.length || 0} moderators`);
            console.log(`📄 Has next page: ${data.has_next_page}`);
            console.log(`📄 Next cursor: ${data.next_cursor || 'none'}`);

            return data;

        } catch (error) {
            console.error('❌ API Error fetching community moderators:', error);
            throw error;
        }
    }

    /**
     * Fetch all moderators with pagination support
     * Fixed to handle YOUR API response structure
     */
    async getAllCommunityModerators(communityId) {
        try {
            const allModerators = [];
            let cursor = null;
            let hasNext = true;
            let pageCount = 0;

            console.log(`📄 PAGINATION: Starting to fetch all moderators for community ${communityId}`);

            while (hasNext && pageCount < 10) { // Safety limit of 10 pages
                pageCount++;
                console.log(`📄 PAGE ${pageCount}: Fetching with cursor: ${cursor || 'initial'}`);

                const response = await this.getCommunityModerators(communityId, cursor);

                // ✅ FIXED: Use "moderators" instead of "members"
                if (response.moderators && response.moderators.length > 0) {
                    allModerators.push(...response.moderators);
                    console.log(`📊 PAGE ${pageCount}: Added ${response.moderators.length} moderators (Total: ${allModerators.length})`);
                }

                // ✅ CONFIRMED: Pagination fields from your API response
                hasNext = response.has_next_page;
                cursor = response.next_cursor;

                if (!hasNext) {
                    console.log(`✅ PAGINATION COMPLETE: No more pages to fetch`);
                    break;
                }

                // Add small delay between requests to be respectful
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            console.log(`🎉 FINAL RESULT: Fetched ${allModerators.length} total moderators across ${pageCount} pages`);
            return allModerators;

        } catch (error) {
            console.error('❌ Error fetching all community moderators:', error);
            throw error;
        }
    }

    /**
     * Transform API moderator data to match your existing format
     * Based on your API response structure
     */
    transformModeratorsToAdminFormat(moderators) {
        return moderators.map(moderator => ({
            username: moderator.screen_name || moderator.name || 'unknown',
            displayName: moderator.name || moderator.screen_name || 'Unknown',
            userId: moderator.id,
            isVerified: moderator.verified || moderator.isBlueVerified,
            followersCount: moderator.followers_count,
            location: moderator.location,
            description: moderator.description,
            profileImageUrl: moderator.profile_image_url_https,
            type: 'Admin',
            source: 'api_fetch'
        }));
    }
}

const twitterAPI = new TwitterAPI();

// ========== COMPREHENSIVE TIMING TRACKER ==========
class TokenTimingTracker {
    constructor() {
        this.timings = new Map(); // Store timing data per token
        this.logFile = path.join(__dirname, 'token_timing_breakdown.txt');
        this.initializeLogFile();
    }

    initializeLogFile() {
        const header = `
${'='.repeat(100)}
TOKEN PROCESSING TIMING BREAKDOWN LOG
Started: ${new Date().toISOString()}
${'='.repeat(100)}

Format for each token:
- Detection: Time from websocket message to processing start
- Wallet Check: Time to check creator wallet against admin lists
- Metadata Fetch: Time to fetch and parse token metadata
- Twitter Extraction: Time to extract Twitter data from metadata
- Community Scraping: Time to scrape community admins (if applicable)
- Admin Matching: Time to match against admin lists
- Snipe Execution: Time to execute the actual snipe
- TOTAL: End-to-end time from detection to completion

${'='.repeat(100)}

`;
        try {
            if (!fs.existsSync(this.logFile)) {
                fs.writeFileSync(this.logFile, header);
                console.log(`📊 Timing breakdown log initialized: ${this.logFile}`);
            }
        } catch (error) {
            console.error('Error initializing timing log:', error);
        }
    }

    startToken(tokenAddress) {
        this.timings.set(tokenAddress, {
            tokenAddress,
            masterStart: Date.now(),
            checkpoints: {},
            phases: {},
            metadata: {}
        });
    }

    checkpoint(tokenAddress, checkpointName) {
        const timing = this.timings.get(tokenAddress);
        if (!timing) return;

        timing.checkpoints[checkpointName] = Date.now();
    }

    recordPhase(tokenAddress, phaseName, duration) {
        const timing = this.timings.get(tokenAddress);
        if (!timing) return;

        timing.phases[phaseName] = duration;
    }

    recordMetadata(tokenAddress, metadata) {
        const timing = this.timings.get(tokenAddress);
        if (!timing) return;

        timing.metadata = { ...timing.metadata, ...metadata };
    }

    finishToken(tokenAddress, outcome, matchDetails = {}) {
        const timing = this.timings.get(tokenAddress);
        if (!timing) return;

        const masterEnd = Date.now();
        const totalTime = masterEnd - timing.masterStart;

        // Calculate phase durations from checkpoints
        const phases = this.calculatePhaseDurations(timing);

        // Create comprehensive summary
        const summary = {
            tokenAddress,
            outcome, // 'sniped', 'detected_only', 'filtered', 'error'
            totalTime,
            phases,
            matchDetails,
            metadata: timing.metadata,
            timestamp: new Date().toISOString()
        };

        // Log to file
        this.logToFile(summary);

        // Log to console with color coding
        this.logToConsole(summary);

        // Clean up
        this.timings.delete(tokenAddress);

        return summary;
    }

    calculatePhaseDurations(timing) {
        const checkpoints = timing.checkpoints;
        const phases = {};

        // Phase 1: Detection to Processing Start
        if (checkpoints.processingStart) {
            phases.detection = checkpoints.processingStart - timing.masterStart;
        }

        // Phase 2: Wallet Check
        if (checkpoints.walletCheckStart && checkpoints.walletCheckEnd) {
            phases.walletCheck = checkpoints.walletCheckEnd - checkpoints.walletCheckStart;
        }

        // Phase 3: Metadata Fetch
        if (checkpoints.metadataStart && checkpoints.metadataEnd) {
            phases.metadataFetch = checkpoints.metadataEnd - checkpoints.metadataStart;
        }

        // Phase 4: Twitter Extraction
        if (checkpoints.twitterExtractionStart && checkpoints.twitterExtractionEnd) {
            phases.twitterExtraction = checkpoints.twitterExtractionEnd - checkpoints.twitterExtractionStart;
        }

        // Phase 5: Community Scraping (if applicable)
        if (checkpoints.communityScrapingStart && checkpoints.communityScrapingEnd) {
            phases.communityScraping = checkpoints.communityScrapingEnd - checkpoints.communityScrapingStart;
        }

        // Phase 6: Admin Matching
        if (checkpoints.adminMatchingStart && checkpoints.adminMatchingEnd) {
            phases.adminMatching = checkpoints.adminMatchingEnd - checkpoints.adminMatchingStart;
        }

        // Phase 7: Snipe Execution
        if (checkpoints.snipeStart && checkpoints.snipeEnd) {
            phases.snipeExecution = checkpoints.snipeEnd - checkpoints.snipeStart;
        }

        // Add any manually recorded phases
        Object.assign(phases, timing.phases);

        return phases;
    }

    logToFile(summary) {
        const { tokenAddress, outcome, totalTime, phases, matchDetails, metadata, timestamp } = summary;

        let logEntry = `
${'─'.repeat(100)}
[${timestamp}] Token: ${tokenAddress}
${'─'.repeat(100)}
OUTCOME: ${outcome.toUpperCase()}
TOTAL TIME: ${totalTime}ms

PHASE BREAKDOWN:
`;

        // Sort phases by typical execution order
        const phaseOrder = [
            'detection',
            'walletCheck',
            'metadataFetch',
            'twitterExtraction',
            'communityScraping',
            'adminMatching',
            'snipeExecution'
        ];

        phaseOrder.forEach(phaseName => {
            if (phases[phaseName] !== undefined) {
                const displayName = phaseName
                    .replace(/([A-Z])/g, ' $1')
                    .replace(/^./, str => str.toUpperCase());
                logEntry += `  ${displayName.padEnd(25)}: ${String(phases[phaseName]).padStart(6)}ms\n`;
            }
        });

        // Add any additional phases not in the standard order
        Object.keys(phases).forEach(phaseName => {
            if (!phaseOrder.includes(phaseName)) {
                const displayName = phaseName
                    .replace(/([A-Z])/g, ' $1')
                    .replace(/^./, str => str.toUpperCase());
                logEntry += `  ${displayName.padEnd(25)}: ${String(phases[phaseName]).padStart(6)}ms\n`;
            }
        });

        // Add match details
        if (Object.keys(matchDetails).length > 0) {
            logEntry += `\nMATCH DETAILS:
`;
            Object.entries(matchDetails).forEach(([key, value]) => {
                logEntry += `  ${key}: ${value}\n`;
            });
        }

        // Add metadata
        if (Object.keys(metadata).length > 0) {
            logEntry += `\nTOKEN METADATA:
`;
            Object.entries(metadata).forEach(([key, value]) => {
                if (typeof value === 'object') {
                    logEntry += `  ${key}: ${JSON.stringify(value)}\n`;
                } else {
                    logEntry += `  ${key}: ${value}\n`;
                }
            });
        }

        logEntry += `${'─'.repeat(100)}\n\n`;

        try {
            fs.appendFileSync(this.logFile, logEntry);
        } catch (error) {
            console.error('Error writing to timing log:', error);
        }
    }

    logToConsole(summary) {
        const { tokenAddress, outcome, totalTime, phases, matchDetails, metadata } = summary;

        // Only create token log file for admin matches (sniped or detected_only outcomes)
        if (!activeTokenLogs.has(tokenAddress) && metadata.tokenName && (outcome === 'sniped' || outcome === 'detected_only')) {
            const logPath = createTokenLogFile(tokenAddress, metadata.tokenName, metadata.tokenSymbol);
            activeTokenLogs.set(tokenAddress, logPath);

            // Write header to file
            const header = `Token Address: ${tokenAddress}\nToken Name: ${metadata.tokenName}\nToken Symbol: ${metadata.tokenSymbol}\nDetection Time: ${new Date().toISOString()}\nOutcome: ${outcome.toUpperCase()}\n\n`;
            fs.writeFileSync(logPath, header);
        }

        // Color codes
        const colors = {
            green: '\x1b[32m',
            yellow: '\x1b[33m',
            red: '\x1b[31m',
            cyan: '\x1b[36m',
            magenta: '\x1b[35m',
            reset: '\x1b[0m',
            bold: '\x1b[1m'
        };

        const outcomeColor =
            outcome === 'sniped' ? colors.green :
                outcome === 'detected_only' ? colors.yellow :
                    outcome === 'filtered' ? colors.cyan : colors.red;

        const line1 = `\n${colors.bold}${'═'.repeat(100)}${colors.reset}`;
        const line2 = `${colors.bold}${outcomeColor}⏱️  TIMING SUMMARY: ${outcome.toUpperCase()}${colors.reset}`;
        const line3 = `${colors.bold}${'═'.repeat(100)}${colors.reset}`;
        const line4 = `${colors.cyan}Token: ${tokenAddress.substring(0, 20)}...${colors.reset}`;
        const line5 = `${colors.bold}${colors.magenta}TOTAL TIME: ${totalTime}ms${colors.reset}\n`;
        const line6 = `${colors.bold}Phase Breakdown:${colors.reset}`;

        // Log to console
        console.log(line1);
        console.log(line2);
        console.log(line3);
        console.log(line4);
        console.log(line5);
        console.log(line6);

        // Only log to file if this is an admin match
        if (outcome === 'sniped' || outcome === 'detected_only') {
            logToTokenFile(tokenAddress, line1);
            logToTokenFile(tokenAddress, line2);
            logToTokenFile(tokenAddress, line3);
            logToTokenFile(tokenAddress, line4);
            logToTokenFile(tokenAddress, line5);
            logToTokenFile(tokenAddress, line6);
        }

        // Display phases with visual bars
        Object.entries(phases).forEach(([phaseName, duration]) => {
            const displayName = phaseName
                .replace(/([A-Z])/g, ' $1')
                .replace(/^./, str => str.toUpperCase())
                .padEnd(25);

            let percentage = 0;
            if (totalTime > 0 && typeof duration === 'number' && !isNaN(duration)) {
                percentage = Math.round((duration / totalTime) * 100);
                percentage = Math.max(0, Math.min(100, percentage));
            }

            const barLength = Math.floor(percentage / 2);
            const safeBarLength = Math.max(0, Math.min(25, barLength));
            const emptyLength = 25 - safeBarLength;
            const safeEmptyLength = Math.max(0, emptyLength);

            const bar = '█'.repeat(safeBarLength) + '░'.repeat(safeEmptyLength);
            const line = `  ${displayName}: ${String(duration).padStart(6)}ms [${bar}] ${percentage}%`;

            console.log(line);

            // Only log to file if this is an admin match
            if (outcome === 'sniped' || outcome === 'detected_only') {
                logToTokenFile(tokenAddress, line);
            }
        });

        if (Object.keys(matchDetails).length > 0) {
            const detailsHeader = `\n${colors.bold}Match Details:${colors.reset}`;
            console.log(detailsHeader);

            // Only log to file if this is an admin match
            if (outcome === 'sniped' || outcome === 'detected_only') {
                logToTokenFile(tokenAddress, detailsHeader);
            }

            Object.entries(matchDetails).forEach(([key, value]) => {
                const line = `  ${key}: ${value}`;
                console.log(line);

                // Only log to file if this is an admin match
                if (outcome === 'sniped' || outcome === 'detected_only') {
                    logToTokenFile(tokenAddress, line);
                }
            });
        }

        const footer = `${colors.bold}${'═'.repeat(100)}${colors.reset}\n`;
        console.log(footer);

        // Only log to file if this is an admin match
        if (outcome === 'sniped' || outcome === 'detected_only') {
            logToTokenFile(tokenAddress, footer);
        }

        // Clean up after logging
        setTimeout(() => {
            activeTokenLogs.delete(tokenAddress);
        }, 5000);
    }

    getStats() {
        return {
            activeTracking: this.timings.size,
            logFile: this.logFile
        };
    }
}

// Create global instance
const timingTracker = new TokenTimingTracker();

// CREATE GLOBAL SCRAPER INSTANCE
const twitterScraper = new TwitterCommunityAdminScraper();

class TokenMetadataExtractor extends OriginalExtractor {
    constructor(rpcUrl) {
        super(rpcUrl || process.env.HELIUS_RPC);
        this.cache = new Map();
        this.cacheTimeout = 60000; // 1 minute cache
    }

    async getCompleteTokenMetadata(tokenAddress) {
        const cached = this.cache.get(tokenAddress);
        if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
            console.log(`📦 Using cached metadata for ${tokenAddress}`);
            return cached.data;
        }

        try {
            const metadata = await super.getCompleteTokenMetadata(tokenAddress);

            this.cache.set(tokenAddress, {
                data: metadata,
                timestamp: Date.now()
            });

            return metadata;
        } catch (error) {
            console.error(`Error fetching token metadata for ${tokenAddress}:`, error.message);
            throw error;
        }
    }

    extractTwitterHandle(metadata) {
        const twitterSources = [];

        const best = this.getBestMetadata(metadata);

        if (best.twitter && best.twitter !== 'Not available') {
            twitterSources.push(best.twitter);
        }

        if (best.website && best.website !== 'Not available' &&
            (best.website.includes('twitter.com') || best.website.includes('x.com'))) {
            twitterSources.push(best.website);
        }

        const sources = [
            metadata.geckoTerminalInfo,
            metadata.birdeyeInfo,
            metadata.jupiterInfo,
            metadata.registryInfo
        ].filter(Boolean);

        sources.forEach(source => {
            if (source.twitter) twitterSources.push(source.twitter);
            if (source.website && (source.website.includes('twitter.com') || source.website.includes('x.com'))) {
                twitterSources.push(source.website);
            }
        });

        if (metadata.offChainMetadata?.attributes) {
            metadata.offChainMetadata.attributes.forEach(attr => {
                if (attr?.trait_type?.toLowerCase() === 'twitter' && attr.value) {
                    twitterSources.push(attr.value);
                }
            });
        }

        console.log(`🔍 Found ${twitterSources.length} potential twitter sources`);

        for (const source of twitterSources) {
            const extracted = this.extractTwitterDataRobust(source);
            if (extracted.type && (extracted.handle || extracted.id)) {
                console.log(`✅ Valid Twitter data: ${extracted.handle || extracted.id}`);
                return extracted;
            }
        }

        return { type: null, handle: null, id: null };
    }

    extractTwitterDataRobust(input) {
        if (!input || typeof input !== 'string') {
            return { type: null, handle: null, id: null };
        }

        const cleanInput = input.trim();

        // ✅ PATTERN 1: Tweet/Status URLs - ADD THIS FIRST
        const tweetMatch = cleanInput.match(/(?:https?:\/\/)?(?:www\.)?(?:twitter\.com\/|x\.com\/)([a-zA-Z0-9_]+)\/status\/(\d{10,20})(?:[?#].*)?/i);
        if (tweetMatch) {
            const username = tweetMatch[1];
            const tweetId = tweetMatch[2];

            console.log(`📱 [TokenMetadataExtractor] Found tweet: @${username} - Tweet ID: ${tweetId}`);

            // Validate username length
            if (username.length >= 1 && username.length <= 15) {
                return {
                    type: 'tweet',
                    id: tweetId,
                    handle: username.toLowerCase()
                };
            }
        }

        // Community pattern
        const communityMatch = cleanInput.match(/(?:https?:\/\/)?(?:www\.)?(?:twitter\.com\/|x\.com\/)i\/communities\/(\d+)/i);
        if (communityMatch) {
            return {
                type: 'community',
                id: communityMatch[1],
                handle: null
            };
        }

        // Individual user pattern - NOW with proper negative lookahead for tweets
        const userMatch = cleanInput.match(/(?:https?:\/\/)?(?:www\.)?(?:twitter\.com\/|x\.com\/)(?!i\/communities\/)(?!.*\/status\/)([a-zA-Z0-9_]+)/i);
        if (userMatch) {
            const handle = userMatch[1].toLowerCase();
            if (this.isValidTwitterHandle(handle)) {
                return {
                    type: 'individual',
                    handle: handle,
                    id: null
                };
            }
        }

        // Handle without URL
        if (cleanInput.startsWith('@')) {
            const handle = cleanInput.substring(1).trim().toLowerCase();
            if (this.isValidTwitterHandle(handle)) {
                return {
                    type: 'individual',
                    handle: handle,
                    id: null
                };
            }
        }

        if (/^[a-zA-Z0-9_]{1,15}$/.test(cleanInput)) {
            const handle = cleanInput.toLowerCase();
            if (this.isValidTwitterHandle(handle)) {
                return {
                    type: 'individual',
                    handle: handle,
                    id: null
                };
            }
        }

        return { type: null, handle: null, id: null };
    }

    isValidTwitterHandle(handle) {
        if (!handle || handle.length < 1 || handle.length > 15) return false;
        if (!/^[a-zA-Z0-9_]+$/.test(handle)) return false;

        const blockedTerms = [
            'home', 'explore', 'messages', 'follow', 'click', 'search',
            'notifications', 'profile', 'settings', 'logout', 'help',
            'about', 'privacy', 'terms', 'status', 'intent', 'share'
        ];

        return !blockedTerms.includes(handle.toLowerCase());
    }
}

// Create the instance
const tokenMetadataExtractor = new TokenMetadataExtractor();

// Global rate limiting for token metadata extraction
class GlobalRateLimiter {
    constructor() {
        this.lastRequestTime = 0;
        this.minInterval = 800; // 800ms between metadata requests
        this.queue = [];
        this.processing = false;
    }

    async executeWithRateLimit(operation) {
        return new Promise((resolve, reject) => {
            this.queue.push({ operation, resolve, reject });
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.processing || this.queue.length === 0) return;

        this.processing = true;

        while (this.queue.length > 0) {
            const now = Date.now();
            const timeSinceLastRequest = now - this.lastRequestTime;

            if (timeSinceLastRequest < this.minInterval) {
                const waitTime = this.minInterval - timeSinceLastRequest;
                console.log(`⏳ Rate limiting: waiting ${waitTime}ms before next request`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }

            const { operation, resolve, reject } = this.queue.shift();
            this.lastRequestTime = Date.now();

            try {
                const result = await operation();
                resolve(result);
            } catch (error) {
                reject(error);
            }

            // Small delay between operations even if we're within rate limits
            if (this.queue.length > 0) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        this.processing = false;
    }
}

const globalRateLimiter = new GlobalRateLimiter();

class BotState {
    constructor() {
        this.isRunning = false;
        this.settings = {
            privateKey: '',
            tokenPageDestination: 'neo_bullx',
            enableAdminFilter: true,
            enableCommunityReuse: true,
            snipeAllTokens: false,
            detectionOnlyMode: true,
            enablePrimaryDetection: true,
            enableSecondaryDetection: true,
            globalSnipeSettings: {
                amount: 0.00099,
                fees: 10,
                mevProtection: false,
                soundNotification: 'system_beep',
                priorityFee: 0.0006
            }
        };
        this.primaryAdminList = new Map();
        this.secondaryAdminList = new Map();
        this.usedCommunities = new Set();
        this.detectedTokens = new Map();
        this.pumpPortalSocket = null;
        this.letsBonkSocket = null;
        this.reconnectTimeouts = new Map();
    }

    addDetectedToken(tokenAddress, tokenData) {
        this.detectedTokens.set(tokenAddress, {
            ...tokenData,
            detectedAt: new Date().toISOString(),
            id: Date.now().toString()
        });

        if (this.detectedTokens.size > 100) {
            const firstKey = this.detectedTokens.keys().next().value;
            this.detectedTokens.delete(firstKey);
        }
    }

    getDetectedTokens() {
        return Array.from(this.detectedTokens.values()).reverse();
    }

    clearDetectedTokens() {
        this.detectedTokens.clear();
    }

    addToList(listType, entry) {
        const config = {
            id: Date.now().toString(),
            address: (entry.address || entry.username).trim(),
            amount: entry.amount || this.settings.globalSnipeSettings.amount,
            fees: entry.fees || this.settings.globalSnipeSettings.fees,
            mevProtection: entry.mevProtection !== undefined ? entry.mevProtection : this.settings.globalSnipeSettings.mevProtection,
            soundNotification: entry.soundNotification || this.settings.globalSnipeSettings.soundNotification,
            priorityFee: entry.priorityFee || this.settings.globalSnipeSettings.priorityFee,
            createdAt: new Date().toISOString()
        };

        switch (listType) {
            case 'primary_admins':
                this.primaryAdminList.set(config.id, config);
                break;
            case 'secondary_admins':
                this.secondaryAdminList.set(config.id, config);
                break;
        }
        return config;
    }

    removeFromList(listType, id) {
        switch (listType) {
            case 'primary_admins':
                return this.primaryAdminList.delete(id);
            case 'secondary_admins':
                return this.secondaryAdminList.delete(id);
        }
        return false;
    }

    getList(listType) {
        switch (listType) {
            case 'primary_admins':
                return Array.from(this.primaryAdminList.values());
            case 'secondary_admins':
                return Array.from(this.secondaryAdminList.values());
            default:
                return [];
        }
    }

    checkAdminInPrimary(identifier) {
        if (!identifier) {
            debugMatchingProcess('N/A', 'PRIMARY_CHECK_SKIPPED', { reason: 'No identifier provided' });
            return null;
        }

        let cleanIdentifier = identifier.trim();
        if (cleanIdentifier.startsWith('@')) {
            cleanIdentifier = cleanIdentifier.substring(1);
        }
        cleanIdentifier = cleanIdentifier.toLowerCase();

        // ✅ DEBUG: Primary admin list scan
        const primaryAdmins = Array.from(this.primaryAdminList.values());
        debugMatchingProcess('N/A', 'PRIMARY_ADMIN_LIST_SCAN', {
            identifier: cleanIdentifier,
            totalEntries: primaryAdmins.length,
            entries: primaryAdmins.map(admin => ({
                address: admin.address,
                amount: admin.amount
            }))
        });

        for (const config of primaryAdmins) {
            let cleanAddress = config.address.trim();
            if (cleanAddress.startsWith('@')) {
                cleanAddress = cleanAddress.substring(1);
            }
            cleanAddress = cleanAddress.toLowerCase();

            if (this.isWalletAddress(identifier) !== this.isWalletAddress(config.address)) {
                continue;
            }

            if (cleanAddress === cleanIdentifier) {
                // ✅ DEBUG: Primary admin match found
                debugMatchingProcess('N/A', 'PRIMARY_ADMIN_MATCH_DETAIL', {
                    identifier: cleanIdentifier,
                    matchedAddress: cleanAddress,
                    configId: config.id,
                    amount: config.amount,
                    fees: config.fees
                });
                return config;
            }
        }

        // ✅ DEBUG: No primary admin match
        debugMatchingProcess('N/A', 'PRIMARY_ADMIN_NO_MATCH', {
            identifier: cleanIdentifier,
            searchedEntries: primaryAdmins.length
        });
        return null;
    }

    checkAdminInSecondary(identifier) {
        if (!identifier) {
            debugMatchingProcess('N/A', 'SECONDARY_CHECK_SKIPPED', { reason: 'No identifier provided' });
            return null;
        }

        let cleanIdentifier = identifier.trim();
        if (cleanIdentifier.startsWith('@')) {
            cleanIdentifier = cleanIdentifier.substring(1);
        }
        cleanIdentifier = cleanIdentifier.toLowerCase();

        // ✅ DEBUG: Secondary admin list scan
        const secondaryAdmins = Array.from(this.secondaryAdminList.values());
        debugMatchingProcess('N/A', 'SECONDARY_ADMIN_LIST_SCAN', {
            identifier: cleanIdentifier,
            totalEntries: secondaryAdmins.length,
            entries: secondaryAdmins.map(admin => ({
                address: admin.address,
                amount: admin.amount
            }))
        });

        for (const config of secondaryAdmins) {
            let cleanAddress = config.address.trim();
            if (cleanAddress.startsWith('@')) {
                cleanAddress = cleanAddress.substring(1);
            }
            cleanAddress = cleanAddress.toLowerCase();

            if (this.isWalletAddress(identifier) !== this.isWalletAddress(config.address)) {
                continue;
            }

            if (cleanAddress === cleanIdentifier) {
                // ✅ DEBUG: Secondary admin match found
                debugMatchingProcess('N/A', 'SECONDARY_ADMIN_MATCH_DETAIL', {
                    identifier: cleanIdentifier,
                    matchedAddress: cleanAddress,
                    configId: config.id,
                    amount: config.amount,
                    fees: config.fees
                });
                return config;
            }
        }

        // ✅ DEBUG: No secondary admin match
        debugMatchingProcess('N/A', 'SECONDARY_ADMIN_NO_MATCH', {
            identifier: cleanIdentifier,
            searchedEntries: secondaryAdmins.length
        });
        return null;
    }

    isWalletAddress(identifier) {
        if (!identifier) return false;
        const clean = identifier.trim();
        return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(clean);
    }
}

// ========== ENHANCED BOTSTATE CLASS WITH FIREBASE ==========

class EnhancedBotState extends BotState {
    constructor() {
        super();
        this.isFirebaseLoaded = false;
    }

    // In EnhancedBotState class
    async addToList(listType, entry) {
        const config = {
            id: Date.now().toString(),
            address: (entry.address || entry.username).trim(),
            amount: entry.amount,
            fees: entry.fees,
            mevProtection: entry.mevProtection,
            soundNotification: entry.soundNotification,
            priorityFee: entry.priorityFee || 0.0005, // ✅ ADD DEFAULT PRIORITY FEE
            createdAt: new Date().toISOString()
        };

        // Add to local state
        switch (listType) {
            case 'primary_admins':
                this.primaryAdminList.set(config.id, config);
                break;
            case 'secondary_admins':
                this.secondaryAdminList.set(config.id, config);
                break;
        }

        // Save to Firebase
        await saveAdminListToFirebase(listType, config);

        // Save to local file
        await saveAdminListsToFile();

        return config;
    }
    // Override removeFromList to save to both Firebase and file
    async removeFromList(listType, id) {
        let success = false;

        // Remove from local state
        switch (listType) {
            case 'primary_admins':
                success = this.primaryAdminList.delete(id);
                break;
            case 'secondary_admins':
                success = this.secondaryAdminList.delete(id);
                break;
        }

        if (success) {
            // Delete from Firebase
            await deleteAdminFromFirebase(listType, id);

            // Save to local file
            await saveAdminListsToFile();
        }

        return success;
    }

    // Enhanced load function with fallback sequence
    async loadAdminListsFromFirebase() {
        try {
            console.log('📥 Loading admin lists with fallback sequence...');

            // Step 1: Try to load from local file first (fastest)
            const fileData = await loadAdminListsFromFile();
            let loadedFromFile = false;

            if (fileData.primary_admins.length > 0 || fileData.secondary_admins.length > 0) {
                console.log('📄 Using cached admin lists from file as initial data');
                this.primaryAdminList.clear();
                this.secondaryAdminList.clear();

                fileData.primary_admins.forEach(admin => {
                    this.primaryAdminList.set(admin.id, admin);
                });

                fileData.secondary_admins.forEach(admin => {
                    this.secondaryAdminList.set(admin.id, admin);
                });

                loadedFromFile = true;
            }

            // Step 2: Try to sync with Firebase (if available)
            try {
                console.log('🔥 Syncing with Firebase...');

                // Load primary admins from Firebase
                const primaryAdmins = await loadAdminListFromFirebase('primary_admins');
                this.primaryAdminList.clear();
                primaryAdmins.forEach(admin => {
                    this.primaryAdminList.set(admin.id, admin);
                });

                // Load secondary admins from Firebase
                const secondaryAdmins = await loadAdminListFromFirebase('secondary_admins');
                this.secondaryAdminList.clear();
                secondaryAdmins.forEach(admin => {
                    this.secondaryAdminList.set(admin.id, admin);
                });

                // Save Firebase data to local file for next time
                await saveAdminListsToFile();

                this.isFirebaseLoaded = true;
                console.log(`✅ Firebase sync successful: ${primaryAdmins.length} primary, ${secondaryAdmins.length} secondary`);

                return {
                    success: true,
                    source: 'firebase',
                    primaryCount: primaryAdmins.length,
                    secondaryCount: secondaryAdmins.length
                };
            } catch (firebaseError) {
                console.error('❌ Firebase sync failed:', firebaseError.message);

                if (loadedFromFile) {
                    console.log('⚠️ Using cached file data as fallback');
                    this.isFirebaseLoaded = false;

                    return {
                        success: true,
                        source: 'file_cache',
                        primaryCount: this.primaryAdminList.size,
                        secondaryCount: this.secondaryAdminList.size,
                        warning: 'Using cached data - Firebase unavailable'
                    };
                } else {
                    console.error('❌ No data available from file or Firebase');
                    this.isFirebaseLoaded = false;

                    return {
                        success: false,
                        source: 'none',
                        error: firebaseError.message
                    };
                }
            }
        } catch (error) {
            console.error('❌ Failed to load admin lists:', error);
            this.isFirebaseLoaded = false;
            return {
                success: false,
                source: 'error',
                error: error.message
            };
        }
    }

    // Get stats including Firebase status
    getStats() {
        return {
            primaryAdmins: this.primaryAdminList.size,
            secondaryAdmins: this.secondaryAdminList.size,
            usedCommunities: this.usedCommunities.size,
            //processedTokens: this.processedTokens.size,
            isFirebaseLoaded: this.isFirebaseLoaded
        };
    }
}

// Create enhanced bot state instance
const botState = new EnhancedBotState();
// WebSocket clients management
const wsClients = new Set();

function broadcastToClients(data) {
    const tokenAddress = data.data?.tokenAddress || data.data?.tokenData?.tokenAddress;
    const adminName = data.data?.tokenData?.matchedEntity || data.data?.matchedEntity || 'unknown';
    const uniqueKey = `${data.type}-${tokenAddress}-${adminName}`;

    // ✅ Deduplication for specific event types
    const shouldDeduplicate = [
        'auto_open_token_page',
        'secondary_popup_trigger',
        'token_detected'
    ].includes(data.type);

    if (shouldDeduplicate && tokenAddress) {
        if (openedTokens.has(uniqueKey)) {
            console.log(`⏭️ SKIPPING DUPLICATE: ${data.type} for ${tokenAddress} (${adminName})`);
            return;
        }

        openedTokens.add(uniqueKey);
        console.log(`✅ MARKED: ${uniqueKey}`);

        // Auto-cleanup after 5 minutes
        setTimeout(() => {
            openedTokens.delete(uniqueKey);
            console.log(`🧹 CLEANED UP: ${uniqueKey}`);
        }, 5 * 60 * 1000);
    }

    const message = JSON.stringify(data);
    console.log(`📡 Broadcasting to ${wsClients.size} clients:`, data.type);

    wsClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// ========== TWITTER DETECTION FUNCTIONS ==========

function extractTwitterData(input) {
    if (!input) return { type: null, id: null, handle: null };

    console.log(`🔍 Extracting Twitter data from: "${input}"`);

    // Clean the input
    const cleanInput = input.trim();

    // Pattern for Twitter community links
    const communityRegex = /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com\/|x\.com\/)i\/communities\/(\d+)/i;
    const communityMatch = cleanInput.match(communityRegex);

    if (communityMatch) {
        console.log(`🏘️ Found community ID: ${communityMatch[1]}`);
        return {
            type: 'community',
            id: communityMatch[1],
            handle: null,
            originalUrl: cleanInput
        };
    }

    // Pattern for individual Twitter accounts (more permissive)
    const userRegex = /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com\/|x\.com\/)(?!i\/communities\/)([a-zA-Z0-9_]+)/i;
    const userMatch = cleanInput.match(userRegex);

    if (userMatch) {
        const handle = userMatch[1].toLowerCase();
        console.log(`👤 Found individual handle: @${handle}`);
        return {
            type: 'individual',
            id: null,
            handle: handle,
            originalUrl: cleanInput
        };
    }

    // If it's just a handle without URL
    if (cleanInput.startsWith('@')) {
        const handle = cleanInput.substring(1).trim().toLowerCase(); // Add .trim()
        console.log(`👤 Found handle without URL: @${handle}`);
        return {
            type: 'individual',
            id: null,
            handle: handle,
            originalUrl: cleanInput
        };
    }

    // If it's just a plain username (be more strict here)
    if (/^[a-zA-Z0-9_]{1,15}$/.test(cleanInput)) {
        const handle = cleanInput.trim().toLowerCase(); // Add .trim()
        console.log(`👤 Found plain username: @${handle}`);
        return {
            type: 'individual',
            id: null,
            handle: handle,
            originalUrl: cleanInput
        };
    }

    console.log(`❌ No Twitter data found in: "${input}"`);
    return { type: null, id: null, handle: null };
}

// Firebase community tracking functions
async function isCommunityUsedInFirebase(communityId) {
    try {
        // Check in-memory cache first (sub-millisecond lookup)
        const isUsed = communityCache.communities.has(communityId.toString());
        console.log(`🔍 Community ${communityId} check: ${isUsed ? 'FOUND in cache' : 'NOT FOUND in cache'}`);
        return isUsed;
    } catch (error) {
        console.error('Error checking community in cache:', error);
        return false; // If error, don't block (safer approach)
    }
}

// Tweet tracking functions
async function isTweetUsedInFirebase(tweetId) {
    try {
        const isUsed = tweetCache.tweets.has(tweetId.toString());
        console.log(`🔍 Tweet ${tweetId} check: ${isUsed ? 'FOUND in cache' : 'NOT FOUND in cache'}`);
        return isUsed;
    } catch (error) {
        console.error('Error checking tweet in cache:', error);
        return false;
    }
}

async function markTweetAsUsedInFirebase(tweetId, username, tokenData) {
    try {
        console.log(`💾 Adding tweet ${tweetId} to local cache and Firebase`);

        const tweetInfo = {
            firstUsed: new Date().toISOString(),
            username: username,
            tokenAddress: tokenData.tokenAddress,
            tokenName: tokenData.name,
            platform: tokenData.platform
        };

        // Add to memory cache
        tweetCache.tweets.set(tweetId.toString(), tweetInfo);

        // ✅ NEW: Immediately save to Firebase (don't wait for periodic sync)
        try {
            const docRef = db.collection('usedTweets').doc(tweetId.toString());
            await docRef.set({
                tweetId: tweetId.toString(),
                username: username,
                firstUsedAt: admin.firestore.FieldValue.serverTimestamp(),
                tokenAddress: tokenData.tokenAddress,
                tokenName: tokenData.name,
                platform: tokenData.platform,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`🔥 Tweet ${tweetId} IMMEDIATELY saved to Firebase`);
        } catch (firebaseError) {
            console.error(`❌ Firebase immediate save failed for tweet ${tweetId}:`, firebaseError.message);
            // Add to pending sync as fallback
            tweetCache.pendingSync.add(tweetId.toString());
            console.log(`📝 Tweet ${tweetId} added to pending sync as fallback`);
        }

        // Also save to local JSON file for crash protection
        await appendTweetToLocalFile(tweetId, tweetInfo);

        // Save full cache to file
        await saveTweetCacheToFile();

        console.log(`✅ Tweet ${tweetId} added to cache, Firebase, and local file`);
        return true;
    } catch (error) {
        console.error(`❌ ERROR adding tweet ${tweetId} to cache:`, error);
        return false;
    }
}

async function appendTweetToLocalFile(tweetId, tweetInfo) {
    try {
        // Read existing tweets
        let existingTweets = {};
        try {
            const fileContent = await fsPromises.readFile(TWEETS_CACHE_FILE, 'utf8');
            const data = JSON.parse(fileContent);
            existingTweets = data.tweets || {};
        } catch (error) {
            // File doesn't exist, start fresh
        }

        // Add new tweet
        existingTweets[tweetId] = tweetInfo;

        // Write back to file immediately
        const updatedCache = {
            tweets: existingTweets,
            lastUpdated: new Date().toISOString()
        };

        await fsPromises.writeFile(TWEETS_CACHE_FILE, JSON.stringify(updatedCache, null, 2));
        console.log(`📄 Tweet ${tweetId} appended to local JSON file`);
    } catch (error) {
        console.error('❌ Error appending tweet to local file:', error);
    }
}

async function saveTweetCacheToFile() {
    try {
        const cacheData = {
            tweets: Object.fromEntries(tweetCache.tweets),
            pendingSync: Array.from(tweetCache.pendingSync),
            lastSyncToFirebase: tweetCache.lastSyncToFirebase,
            lastUpdated: new Date().toISOString()
        };

        await fsPromises.writeFile(TWEETS_CACHE_FILE, JSON.stringify(cacheData, null, 2));
        console.log(`💾 Tweet cache saved to file (${tweetCache.tweets.size} tweets)`);
    } catch (error) {
        console.error('❌ Error saving tweet cache to file:', error);
    }
}

async function initializeTweetCache() {
    try {
        console.log('🚀 Initializing local tweet cache...');

        try {
            const fileContent = await fsPromises.readFile(TWEETS_CACHE_FILE, 'utf8');
            const data = JSON.parse(fileContent);

            if (data.tweets) {
                Object.entries(data.tweets).forEach(([id, info]) => {
                    tweetCache.tweets.set(id, info);
                });
            }

            tweetCache.pendingSync = new Set(data.pendingSync || []);
            console.log(`✅ Loaded ${tweetCache.tweets.size} tweets from cache file`);
        } catch (error) {
            console.log('📄 No tweet cache file found, loading from Firebase...');
            await loadInitialTweetsFromFirebase();
        }

        startPeriodicTweetFirebaseSync();
    } catch (error) {
        console.error('❌ Error initializing tweet cache:', error);
    }
}

async function loadInitialTweetsFromFirebase() {
    try {
        const snapshot = await db.collection('usedTweets').get();
        let loadedCount = 0;

        snapshot.forEach(doc => {
            const data = doc.data();
            tweetCache.tweets.set(doc.id, {
                firstUsed: data.firstUsedAt?.toDate?.()?.toISOString() || new Date().toISOString(),
                username: data.username,
                tokenAddress: data.tokenAddress,
                tokenName: data.tokenName,
                platform: data.platform
            });
            loadedCount++;
        });

        console.log(`✅ Loaded ${loadedCount} tweets from Firebase`);
        await saveTweetCacheToFile();
    } catch (error) {
        console.error('❌ Error loading tweets from Firebase:', error);
    }
}

function startPeriodicTweetFirebaseSync() {
    setInterval(async () => {
        if (tweetCache.pendingSync.size > 0) {
            await syncPendingTweetsToFirebase();
        }
    }, FIREBASE_SYNC_INTERVAL);
}

async function syncPendingTweetsToFirebase() {
    if (tweetCache.pendingSync.size === 0) {
        console.log(`📊 No pending tweets to sync to Firebase (all should be immediately synced)`);
        return;
    }

    console.log(`🔄 Syncing ${tweetCache.pendingSync.size} FAILED tweets to Firebase (backup sync)...`);
    console.log(`⚠️ Note: These tweets failed immediate sync and are being retried`);

    const batch = db.batch();
    let syncCount = 0;

    for (const tweetId of tweetCache.pendingSync) {
        const tweetData = tweetCache.tweets.get(tweetId);
        if (tweetData) {
            const docRef = db.collection('usedTweets').doc(tweetId);
            batch.set(docRef, {
                tweetId: tweetId,
                username: tweetData.username,
                firstUsedAt: admin.firestore.FieldValue.serverTimestamp(),
                tokenAddress: tweetData.tokenAddress,
                tokenName: tweetData.tokenName,
                platform: tweetData.platform,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            syncCount++;
        }
    }

    try {
        await batch.commit();
        console.log(`✅ Successfully synced ${syncCount} tweets to Firebase`);
        tweetCache.pendingSync.clear();
        tweetCache.lastSyncToFirebase = new Date().toISOString();
        await saveTweetCacheToFile();
    } catch (error) {
        console.error('❌ Error syncing tweets to Firebase:', error);
    }
}

async function getPairAddressFromDexScreener(tokenAddress) {
    try {
        console.log(`🔍 Fetching pair address for token: ${tokenAddress}`);

        // Use the actual token address, not hardcoded one
        const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;

        const response = await fetch(url, {
            timeout: 10000, // 10 second timeout
            headers: {
                'User-Agent': 'DevScope-Bot/1.0'
            }
        });

        if (!response.ok) {
            console.log(`❌ DexScreener API error: ${response.status}`);
            return null;
        }

        const data = await response.json();
        console.log(`📊 DexScreener response:`, data);

        if (data.pairs && data.pairs.length > 0) {
            // Find Raydium pair first, or fallback to first available pair
            let bestPair = data.pairs.find(pair =>
                pair.dexId === 'raydium' ||
                pair.dexId.toLowerCase().includes('raydium')
            ) || data.pairs[0];

            console.log(`✅ Found pair on ${bestPair.dexId}: ${bestPair.pairAddress}`);

            return {
                pairAddress: bestPair.pairAddress,
                dexId: bestPair.dexId,
                baseToken: bestPair.baseToken,
                quoteToken: bestPair.quoteToken,
                liquidity: bestPair.liquidity,
                url: bestPair.url
            };
        }

        console.log(`❌ No pairs found for token: ${tokenAddress}`);
        return null;
    } catch (error) {
        console.error('❌ Error fetching pair data from DexScreener:', error);
        return null;
    }
}

async function markCommunityAsUsedInFirebase(communityId, tokenData) {
    try {
        console.log(`💾 Adding community ${communityId} to local cache and Firebase`);

        const communityInfo = {
            firstUsed: new Date().toISOString(),
            tokenCount: 1,
            tokenAddress: tokenData.tokenAddress,
            tokenName: tokenData.name,
            platform: tokenData.platform
        };

        // Add to in-memory cache immediately
        communityCache.communities.set(communityId.toString(), communityInfo);

        // ✅ NEW: Immediately save to Firebase (don't wait for periodic sync)
        try {
            const docRef = db.collection('usedCommunities').doc(communityId.toString());
            await docRef.set({
                communityId: communityId.toString(),
                firstUsedAt: admin.firestore.FieldValue.serverTimestamp(),
                tokenAddress: tokenData.tokenAddress,
                tokenName: tokenData.name,
                platform: tokenData.platform,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`🔥 Community ${communityId} IMMEDIATELY saved to Firebase`);
        } catch (firebaseError) {
            console.error(`❌ Firebase immediate save failed for community ${communityId}:`, firebaseError.message);
            // Add to pending sync as fallback
            communityCache.pendingSync.add(communityId.toString());
            console.log(`📝 Community ${communityId} added to pending sync as fallback`);
        }

        // Save to local file immediately for crash protection
        await saveCacheToFile();

        console.log(`✅ Community ${communityId} added to cache, Firebase, and local file`);
        return true;
    } catch (error) {
        console.error(`❌ ERROR adding community ${communityId} to cache:`, error);
        return false;
    }
}

// Initialize cache on startup
async function initializeCommunityCache() {
    try {
        console.log('🚀 Initializing local community cache...');

        // Load from file if exists
        try {
            const fileContent = await fsPromises.readFile(COMMUNITY_CACHE_FILE, 'utf8');
            const data = JSON.parse(fileContent);

            // Convert to Map for performance
            if (data.communities) {
                Object.entries(data.communities).forEach(([id, info]) => {
                    communityCache.communities.set(id, info);
                });
            }

            communityCache.lastSyncToFirebase = data.lastSyncToFirebase;
            communityCache.pendingSync = new Set(data.pendingSync || []);

            console.log(`✅ Loaded ${communityCache.communities.size} communities from cache file`);
        } catch (error) {
            console.log('📄 No cache file found, loading from Firebase...');
            await loadInitialDataFromFirebase();
        }

        // Start periodic sync
        startPeriodicFirebaseSync();

    } catch (error) {
        console.error('❌ Error initializing community cache:', error);
    }
}

// Load initial data from Firebase (one-time)
async function loadInitialDataFromFirebase() {
    try {
        const snapshot = await db.collection('usedCommunities').get();
        let loadedCount = 0;

        snapshot.forEach(doc => {
            const data = doc.data();
            communityCache.communities.set(doc.id, {
                firstUsed: data.firstUsedAt?.toDate?.()?.toISOString() || new Date().toISOString(),
                tokenCount: 1,
                tokenAddress: data.tokenAddress,
                tokenName: data.tokenName,
                platform: data.platform
            });
            loadedCount++;
        });

        console.log(`✅ Loaded ${loadedCount} communities from Firebase`);
        await saveCacheToFile();
    } catch (error) {
        console.error('❌ Error loading from Firebase:', error);
    }
}

// Save cache to local file
async function saveCacheToFile() {
    try {
        const cacheData = {
            communities: Object.fromEntries(communityCache.communities),
            pendingSync: Array.from(communityCache.pendingSync),
            lastSyncToFirebase: communityCache.lastSyncToFirebase,
            lastUpdated: new Date().toISOString()
        };

        await fsPromises.writeFile(COMMUNITY_CACHE_FILE, JSON.stringify(cacheData, null, 2));
        console.log(`💾 Cache saved to file (${communityCache.communities.size} communities)`);
    } catch (error) {
        console.error('❌ Error saving cache to file:', error);
    }
}

// Periodic Firebase sync
function startPeriodicFirebaseSync() {
    setInterval(async () => {
        if (communityCache.pendingSync.size > 0) {
            await syncPendingToFirebase();
        }
    }, FIREBASE_SYNC_INTERVAL);

    console.log(`⏰ Started periodic Firebase sync (every ${FIREBASE_SYNC_INTERVAL / 60000} minutes)`);
}

// Sync pending communities to Firebase
async function syncPendingToFirebase() {
    if (communityCache.pendingSync.size === 0) return;

    console.log(`🔄 Syncing ${communityCache.pendingSync.size} communities to Firebase...`);

    const batch = db.batch();
    let syncCount = 0;

    for (const communityId of communityCache.pendingSync) {
        const communityData = communityCache.communities.get(communityId);
        if (communityData) {
            const docRef = db.collection('usedCommunities').doc(communityId);
            batch.set(docRef, {
                communityId: communityId,
                firstUsedAt: admin.firestore.FieldValue.serverTimestamp(),
                tokenAddress: communityData.tokenAddress,
                tokenName: communityData.tokenName,
                platform: communityData.platform,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            syncCount++;
        }
    }

    try {
        await batch.commit();
        console.log(`✅ Successfully synced ${syncCount} communities to Firebase`);

        // Clear pending sync
        communityCache.pendingSync.clear();
        communityCache.lastSyncToFirebase = new Date().toISOString();

        // Update local file
        await saveCacheToFile();
    } catch (error) {
        console.error('❌ Error syncing to Firebase:', error);
    }
}

async function getTwitterDataFromToken(tokenData) {
    try {
        let twitterData = { type: null, id: null, handle: null, admin: null };

        // Get enhanced metadata using new Token Metadata API
        const metadata = await fetchTokenMetadata(tokenData);

        console.log('🔍 Enhanced metadata available:', {
            hasEnhancedData: metadata.hasEnhancedData,
            isBonkToken: metadata.isBonkToken,
            twitterHandle: metadata.twitterHandle,
            websites: metadata.websites?.length || 0
        });

        // Enhanced Twitter extraction with priority system
        const twitterSources = [];

        // Priority 1: Direct twitter handle from enhanced metadata
        if (metadata.hasEnhancedData) {
            if (metadata.twitterHandle) {
                twitterSources.push({
                    value: metadata.twitterHandle,
                    source: 'enhanced_metadata_twitter_handle'
                });
            }

            // Check websites for Twitter links
            if (metadata.websites && Array.isArray(metadata.websites)) {
                metadata.websites.forEach((website, index) => {
                    if (website && typeof website === 'string' &&
                        (website.includes('twitter.com') || website.includes('x.com'))) {
                        twitterSources.push({
                            value: website,
                            source: `enhanced_metadata_websites[${index}]`
                        });
                    }
                });
            }

            // Check website field
            if (metadata.website &&
                (metadata.website.includes('twitter.com') || metadata.website.includes('x.com'))) {
                twitterSources.push({
                    value: metadata.website,
                    source: 'enhanced_metadata_website'
                });
            }

            // If we have raw metadata, extract from it too
            if (metadata.rawMetadata) {
                const twitterFromRaw = tokenMetadataExtractor.extractTwitterHandle(metadata.rawMetadata);
                if (twitterFromRaw.handle) {
                    twitterSources.push({
                        value: twitterFromRaw.handle,
                        source: 'raw_metadata_extraction'
                    });
                } else if (twitterFromRaw.id) {
                    twitterSources.push({
                        value: `https://x.com/i/communities/${twitterFromRaw.id}`,
                        source: 'raw_metadata_community'
                    });
                }
            }
        }

        // Priority 2: Original token data fields (fallback)
        const fieldsToCheck = [
            { field: 'twitter', source: 'token_twitter' },
            { field: 'social?.twitter', source: 'token_social_twitter' },
            { field: 'website', source: 'token_website' },
            { field: 'metadata?.twitter', source: 'metadata_twitter' },
            { field: 'metadata?.social?.twitter', source: 'metadata_social_twitter' },
            { field: 'metadata?.website', source: 'metadata_website' },
            { field: 'metadata?.external_url', source: 'metadata_external_url' }
        ];

        fieldsToCheck.forEach(({ field, source }) => {
            const value = getNestedValue(tokenData, field);
            if (value && typeof value === 'string') {
                twitterSources.push({ value, source });
            }
        });

        console.log('🔍 Enhanced fields to check for Twitter data:', twitterSources.map(s => `${s.value} (${s.source})`));

        // Process each source and use the first valid match
        for (const twitterSource of twitterSources) {
            if (twitterSource.value && typeof twitterSource.value === 'string') {
                const extracted = extractTwitterDataRobust(twitterSource.value, twitterSource.source);
                if (extracted.type) {
                    console.log(`✅ Found Twitter data: ${extracted.type} - ${extracted.handle || extracted.id} from ${twitterSource.source}`);
                    if (metadata.hasEnhancedData) {
                        console.log('🚀 Twitter data source: Token Metadata API');
                    }
                    twitterData = extracted;
                    break;
                }
            }
        }

        // Set admin based on type
        if (twitterData.type === 'individual') {
            twitterData.admin = twitterData.handle;
        } else if (twitterData.type === 'community') {
            twitterData.admin = twitterData.id;
        }

        console.log('🔍 Final enhanced Twitter data result:', twitterData);

        return {
            ...twitterData,
            enhancedMetadata: metadata
        };
    } catch (error) {
        console.error('Error extracting enhanced Twitter data:', error);
        return {
            type: null,
            id: null,
            handle: null,
            admin: null,
            enhancedMetadata: { hasEnhancedData: false, isBonkToken: false }
        };
    }
}

app.get('/api/timing-stats', (req, res) => {
    const stats = timingTracker.getStats();
    res.json({
        success: true,
        stats,
        logFile: stats.logFile,
        activeTracking: stats.activeTracking
    });
});

app.get('/api/timing-log', (req, res) => {
    try {
        const logContent = fs.readFileSync(timingTracker.logFile, 'utf8');
        res.json({
            success: true,
            content: logContent,
            size: fs.statSync(timingTracker.logFile).size
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Add this endpoint to check the status of admin list caching
app.get('/api/admin-cache-status', (req, res) => {
    try {
        const fileExists = fs.existsSync(ADMIN_CACHE_FILE);
        let fileStats = null;

        if (fileExists) {
            fileStats = fs.statSync(ADMIN_CACHE_FILE);
        }

        res.json({
            success: true,
            fileExists,
            lastModified: fileStats ? fileStats.mtime.toISOString() : null,
            fileSize: fileStats ? fileStats.size : 0,
            firebaseLoaded: botState.isFirebaseLoaded,
            primaryCount: botState.primaryAdminList.size,
            secondaryCount: botState.secondaryAdminList.size,
            cacheFile: ADMIN_CACHE_FILE
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== LOG MANAGEMENT ENDPOINTS ==========
app.get('/api/logs/current-session', (req, res) => {
    try {
        const currentLogPath = path.join(LOG_DIR, 'current-session.log');
        if (fs.existsSync(currentLogPath)) {
            const logContent = fs.readFileSync(currentLogPath, 'utf8');
            res.json({
                success: true,
                content: logContent,
                size: fs.statSync(currentLogPath).size
            });
        } else {
            res.json({
                success: true,
                content: '',
                message: 'No current session log found'
            });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/debug/analyze-vault-seeds', async (req, res) => {
    try {
        const { PublicKey } = require('@solana/web3.js');
        const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

        const knownMint = new PublicKey("GGSQ9yu71Bnutbw9E25VyAtvoLgMsmQrvS7kzRUcpump");
        const knownCreator = new PublicKey("B3ewY5sjehUoLKByWJveZ3LiPsDmMMKpQy6iBLyK73Ey");
        const knownVault = new PublicKey("Fv8dqzqw47AjnuGTFdnXVFqAJZiMMd39ZHZfhiXv5h8m");

        console.log('\n' + '='.repeat(80));
        console.log('🔍 TESTING DIFFERENT VAULT PDA SEED COMBINATIONS');
        console.log('='.repeat(80));

        const seedCombinations = [
            // Different seed strings
            { seeds: [Buffer.from("vault"), knownCreator.toBuffer(), knownMint.toBuffer()], desc: "vault + creator + mint" },
            { seeds: [Buffer.from("creator-vault"), knownCreator.toBuffer(), knownMint.toBuffer()], desc: "creator-vault + creator + mint" },
            { seeds: [Buffer.from("creator_vault"), knownCreator.toBuffer(), knownMint.toBuffer()], desc: "creator_vault + creator + mint" },
            { seeds: [knownCreator.toBuffer(), knownMint.toBuffer()], desc: "creator + mint (no prefix)" },
            { seeds: [Buffer.from("vault"), knownMint.toBuffer(), knownCreator.toBuffer()], desc: "vault + mint + creator (reversed)" },
            { seeds: [Buffer.from("creator-vault"), knownMint.toBuffer(), knownCreator.toBuffer()], desc: "creator-vault + mint + creator" },

            // With bonding curve
            { seeds: [Buffer.from("vault"), knownCreator.toBuffer()], desc: "vault + creator only" },
            { seeds: [Buffer.from("creator-vault"), knownCreator.toBuffer()], desc: "creator-vault + creator only" },

            // Try with bonding curve address
            { seeds: [Buffer.from("vault"), new PublicKey("2A62gqHgL2yRmMrEM3brtJeGCDt7FpNaG2dGLkmHRt1a").toBuffer()], desc: "vault + bonding curve" },
        ];

        const results = [];

        for (const combo of seedCombinations) {
            try {
                const [calculatedVault, bump] = PublicKey.findProgramAddressSync(
                    combo.seeds,
                    PUMP_FUN_PROGRAM
                );

                const matches = calculatedVault.toBase58() === knownVault.toBase58();

                results.push({
                    description: combo.desc,
                    calculatedVault: calculatedVault.toBase58(),
                    bump: bump,
                    matches: matches
                });

                const icon = matches ? '✅ MATCH!' : '❌';
                console.log(`${icon} ${combo.desc}`);
                console.log(`   Calculated: ${calculatedVault.toBase58()}`);
                if (matches) {
                    console.log(`   🎉 THIS IS THE CORRECT SEED COMBINATION!`);
                    console.log(`   Bump: ${bump}`);
                }
                console.log('');

            } catch (e) {
                console.log(`❌ ${combo.desc}: Failed - ${e.message}\n`);
                results.push({
                    description: combo.desc,
                    error: e.message,
                    matches: false
                });
            }
        }

        const correctCombo = results.find(r => r.matches);

        if (correctCombo) {
            console.log('\n' + '='.repeat(80));
            console.log('🎉 FOUND THE CORRECT VAULT SEED COMBINATION!');
            console.log('='.repeat(80));
            console.log(`✅ ${correctCombo.description}`);
            console.log(`✅ Vault: ${correctCombo.calculatedVault}`);
            console.log(`✅ Bump: ${correctCombo.bump}`);
            console.log('='.repeat(80) + '\n');
        }

        res.json({
            success: true,
            knownValues: {
                mint: knownMint.toBase58(),
                creator: knownCreator.toBase58(),
                vault: knownVault.toBase58()
            },
            results: results,
            correctCombination: correctCombo || null
        });

    } catch (error) {
        console.error('❌ Analysis failed:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/reverse-engineer-creator-vault', async (req, res) => {
    try {
        const { PublicKey } = require('@solana/web3.js');
        const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

        // Known working values from the Solscan transaction
        const knownMint = new PublicKey("GGSQ9yu71Bnutbw9E25VyAtvoLgMsmQrvS7kzRUcpump");
        const knownCreator = new PublicKey("B3ewY5sjehUoLKByWJveZ3LiPsDmMMKpQy6iBLyK73Ey");
        const knownCreatorVault = "Fv8dqzqw47AjnuGTFdnXVFqAJZiMMd39ZHZfhiXv5h8m";

        console.log('\n' + '='.repeat(80));
        console.log('🔍 REVERSE ENGINEERING CREATOR VAULT PDA');
        console.log('='.repeat(80));
        console.log('Known values from successful transaction:');
        console.log(`  Mint: ${knownMint.toBase58()}`);
        console.log(`  Creator: ${knownCreator.toBase58()}`);
        console.log(`  Creator Vault (expected): ${knownCreatorVault}`);
        console.log('='.repeat(80) + '\n');

        // Calculate bonding curve to verify it
        const [bondingCurve] = PublicKey.findProgramAddressSync(
            [Buffer.from("bonding-curve"), knownMint.toBytes()],
            PUMP_FUN_PROGRAM
        );
        console.log(`📊 Calculated Bonding Curve: ${bondingCurve.toBase58()}`);

        // Fetch the bonding curve account to extract creator
        const accountInfo = await connection.getAccountInfo(bondingCurve);
        console.log(`📦 Bonding Curve Account Data Length: ${accountInfo.data.length} bytes`);

        // Try different offsets to find where creator is stored
        console.log('\n🔍 Testing different offsets for creator extraction:\n');

        const offsetsToTest = [8, 16, 24, 32, 40, 41, 48, 49, 56, 64, 72, 80];
        const results = [];

        for (const offset of offsetsToTest) {
            try {
                const extractedCreator = new PublicKey(accountInfo.data.slice(offset, offset + 32));
                const matchesKnown = extractedCreator.toBase58() === knownCreator.toBase58();

                // Calculate creator vault with this creator
                const [calculatedVault] = PublicKey.findProgramAddressSync(
                    [Buffer.from("vault"), extractedCreator.toBuffer(), knownMint.toBuffer()],
                    PUMP_FUN_PROGRAM
                );

                const vaultMatches = calculatedVault.toBase58() === knownCreatorVault;

                const result = {
                    offset,
                    extractedCreator: extractedCreator.toBase58(),
                    creatorMatches: matchesKnown,
                    calculatedVault: calculatedVault.toBase58(),
                    vaultMatches: vaultMatches,
                    isCorrect: matchesKnown && vaultMatches
                };

                results.push(result);

                const icon = result.isCorrect ? '✅ CORRECT!' :
                    result.creatorMatches ? '⚠️  Creator match but vault mismatch' :
                        result.vaultMatches ? '⚠️  Vault match but creator mismatch' : '❌';

                console.log(`${icon} Offset ${offset}:`);
                console.log(`     Creator: ${extractedCreator.toBase58()}`);
                console.log(`     Vault:   ${calculatedVault.toBase58()}`);
                console.log('');

            } catch (e) {
                console.log(`❌ Offset ${offset}: Failed - ${e.message}\n`);
            }
        }

        const correctResult = results.find(r => r.isCorrect);

        if (correctResult) {
            console.log('\n' + '='.repeat(80));
            console.log('🎉 FOUND THE CORRECT OFFSET!');
            console.log('='.repeat(80));
            console.log(`✅ Correct offset: ${correctResult.offset}`);
            console.log(`✅ This offset correctly extracts the creator and calculates the vault`);
            console.log('='.repeat(80) + '\n');
        } else {
            console.log('\n⚠️  No offset produced both matching creator AND matching vault');
            console.log('This suggests the PDA seed structure might be different\n');
        }

        res.json({
            success: true,
            knownValues: {
                mint: knownMint.toBase58(),
                creator: knownCreator.toBase58(),
                creatorVault: knownCreatorVault,
                bondingCurve: bondingCurve.toBase58()
            },
            bondingCurveDataLength: accountInfo.data.length,
            testResults: results,
            correctOffset: correctResult ? correctResult.offset : null,
            recommendation: correctResult
                ? `Use offset ${correctResult.offset} in getBondingCurveData()`
                : 'Unable to find correct offset - PDA seeds may be wrong'
        });

    } catch (error) {
        console.error('❌ Reverse engineering failed:', error);
        res.status(500).json({
            error: error.message,
            stack: error.stack
        });
    }
});

app.post('/api/detection-settings', (req, res) => {
    const {
        enablePrimaryDetection,
        enableSecondaryDetection
    } = req.body;

    console.log('🔧 Received separate detection settings update:', {
        enablePrimaryDetection,
        enableSecondaryDetection
    });

    // Update primary detection toggle
    if (typeof enablePrimaryDetection !== 'undefined') {
        botState.settings.enablePrimaryDetection = enablePrimaryDetection;
        console.log(`🎯 Primary admin detection: ${enablePrimaryDetection ? 'ENABLED' : 'DISABLED'}`);
    }

    // Update secondary detection toggle
    if (typeof enableSecondaryDetection !== 'undefined') {
        botState.settings.enableSecondaryDetection = enableSecondaryDetection;
        console.log(`🔔 Secondary admin detection: ${enableSecondaryDetection ? 'ENABLED' : 'DISABLED'}`);
    }

    // Log current detection configuration
    console.log('📊 Current detection configuration:', {
        enablePrimaryDetection: botState.settings.enablePrimaryDetection,
        enableSecondaryDetection: botState.settings.enableSecondaryDetection
    });

    // Return updated settings
    res.json({
        success: true,
        settings: {
            enablePrimaryDetection: botState.settings.enablePrimaryDetection,
            enableSecondaryDetection: botState.settings.enableSecondaryDetection
        },
        message: 'Detection settings updated successfully',
        explanation: getDetectionExplanation(botState.settings),
        warnings: getDetectionWarnings(botState.settings)
    });
});

function getDetectionExplanation(settings) {
    if (!settings.enablePrimaryDetection && !settings.enableSecondaryDetection) {
        return '❌ All admin detection is DISABLED - no tokens will be detected from admin lists';
    } else if (settings.enablePrimaryDetection && !settings.enableSecondaryDetection) {
        return '🎯 Only PRIMARY admin detection is ENABLED - will auto-snipe primary matches only';
    } else if (!settings.enablePrimaryDetection && settings.enableSecondaryDetection) {
        return '🔔 Only SECONDARY admin detection is ENABLED - will show popups for secondary matches only';
    } else {
        return '✅ Both PRIMARY and SECONDARY detection are ENABLED - full detection system active';
    }
}

// Helper function for warnings
function getDetectionWarnings(settings) {
    const warnings = [];

    if (!settings.enablePrimaryDetection && !settings.enableSecondaryDetection) {
        warnings.push('🚨 All admin detection is OFF - no tokens will be detected from your admin lists!');
    }

    if (settings.enablePrimaryDetection && !settings.detectionOnlyMode) {
        warnings.push('⚠️ Primary detection is ON with auto-snipe - primary matches will be automatically sniped');
    }

    if (settings.enableSecondaryDetection) {
        warnings.push('🔔 Secondary detection is ON - matches will trigger popup notifications');
    }

    return warnings;
}

// Add after your other API endpoints
app.get('/api/debug/opened-tokens', (req, res) => {
    res.json({
        openedTokens: Array.from(openedTokens),
        count: openedTokens.size
    });
});

app.get('/api/logs/files', (req, res) => {
    try {
        const files = fs.readdirSync(LOG_DIR)
            .filter(file => file.endsWith('.log'))
            .map(file => {
                const filePath = path.join(LOG_DIR, file);
                const stats = fs.statSync(filePath);
                return {
                    name: file,
                    size: stats.size,
                    modified: stats.mtime,
                    created: stats.birthtime
                };
            })
            .sort((a, b) => new Date(b.modified) - new Date(a.modified));

        res.json({
            success: true,
            files: files,
            totalFiles: files.length
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/logs/download/:filename', (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join(LOG_DIR, filename);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Log file not found' });
        }

        res.download(filePath, filename);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/logs/clear', (req, res) => {
    try {
        const files = fs.readdirSync(LOG_DIR);
        let deletedCount = 0;

        files.forEach(file => {
            if (file.endsWith('.log')) {
                fs.unlinkSync(path.join(LOG_DIR, file));
                deletedCount++;
            }
        });

        res.json({
            success: true,
            message: `Cleared ${deletedCount} log files`,
            deletedCount: deletedCount
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/test-token-metadata/:tokenAddress', async (req, res) => {
    try {
        const { tokenAddress } = req.params;

        console.log(`🧪 Testing Token Metadata API for: ${tokenAddress}`);

        const completeMetadata = await tokenMetadataExtractor.getCompleteTokenMetadata(tokenAddress);
        const twitterInfo = tokenMetadataExtractor.extractTwitterHandle(completeMetadata);
        const bestMetadata = tokenMetadataExtractor.getBestMetadata(completeMetadata);

        res.json({
            success: true,
            tokenAddress,
            completeMetadata,
            bestMetadata,
            twitterInfo,
            extractedFields: {
                name: bestMetadata?.name,
                symbol: bestMetadata?.symbol,
                logoURI: bestMetadata?.logoURI,
                twitter_handle: twitterInfo?.handle,
                twitter_community: twitterInfo?.id,
                website: bestMetadata?.website,
                description: bestMetadata?.description,
                supply: bestMetadata?.supply
            }
        });
    } catch (error) {
        console.error('❌ Token Metadata API test failed:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            tokenAddress: req.params.tokenAddress
        });
    }
});

console.log('🔥 Firebase Admin SDK initialized');
console.log('Project ID:', admin.app().options.projectId);

// Test Firebase connection at startup
async function testFirebase() {
    try {
        const testDoc = await db.collection('test').doc('connection').set({
            test: true,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log('✅ Firebase connection test successful');
    } catch (error) {
        console.error('❌ Firebase connection test failed:', error);
    }
}

// ========== TRADING FUNCTIONS ==========

// ========== DIRECT BONDING CURVE BUY (NO API) ==========
const {
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction
} = require('@solana/spl-token');
const BN = require('bn.js');

// Pump.fun constants - CORRECTED VERSION
const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_FUN_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
const PUMP_FUN_EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'); // ✅ CHANGED - same as program
const PUMP_FUN_FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');
const SYSTEM_RENT = new PublicKey('SysvarRent111111111111111111111111111111111');

const PUMP_FUN_FEE_CONFIG = new PublicKey('8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt');
const PUMP_FUN_GLOBAL_VOLUME = new PublicKey('Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y');
const PUMP_FUN_FEES_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

/**
 * Get associated bonding curve token account
 * ✅ This is the ONLY calculation needed - you already have bondingCurve from websocket!
 */
function getAssociatedBondingCurveAddress(bondingCurve, mint) {
    const [pda] = PublicKey.findProgramAddressSync(
        [
            bondingCurve.toBuffer(),
            TOKEN_PROGRAM_ID.toBuffer(),
            mint.toBuffer()
        ],
        ASSOCIATED_TOKEN_PROGRAM_ID
    );
    return pda;
}

/**
 * Create buy instruction for Pump.fun
 */
/**
 * CORRECTED: Create buy instruction for Pump.fun with all required accounts
 */
/**
 * CORRECTED: Create buy instruction for Pump.fun with proper accounts
 */

/**
 * CORRECTED: Create buy instruction for Pump.fun with ALL required accounts
 * Based on actual transaction: https://solscan.io/tx/[transaction_hash]
 */

/**
 * Get bonding curve data to extract creator address
 */

async function getBondingCurveData(connection, bondingCurve) {
    try {
        const accountInfo = await connection.getAccountInfo(bondingCurve);
        if (!accountInfo) {
            throw new Error('Bonding curve account not found');
        }

        // Creator is at offset 49
        const creator = new PublicKey(accountInfo.data.slice(49, 49 + 32));

        console.log('📍 Extracted creator from bonding curve:', creator.toBase58());

        return { creator };
    } catch (error) {
        console.error('Error fetching bonding curve data:', error);
        throw error;
    }
}

/**
 * Updated: Create buy instruction with creator address
 */

/**
 * CORRECTED: Create buy instruction for Pump.fun with proper creator_vault calculation
 */
function createPumpFunBuyInstruction(
    buyer,
    mint,
    bondingCurve,
    associatedBondingCurve,
    associatedUser,
    creator,
    tokenAmount,        // ✅ Token amount in base units
    maxSolCost         // ✅ Max SOL to spend (lamports)
) {
    const BUY_DISCRIMINATOR = Buffer.from([
        0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea
    ]);

    // ✅ CORRECT: First parameter is TOKEN AMOUNT
    const tokenAmountBuffer = new BN(tokenAmount).toArrayLike(Buffer, 'le', 8);

    // ✅ CORRECT: Second parameter is MAX SOL COST
    const maxSolBuffer = new BN(maxSolCost).toArrayLike(Buffer, 'le', 8);

    const data = Buffer.concat([
        BUY_DISCRIMINATOR,
        tokenAmountBuffer,  // ✅ Token amount first
        maxSolBuffer        // ✅ Max SOL second
    ]);

    // ✅ CORRECTED: Use "vault" as the seed, not the creator's public key directly
    const [creatorVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("creator-vault"), creator.toBuffer()],  // ✅ NO mint address!
        PUMP_FUN_PROGRAM
    );

    console.log('💰 Creator vault:', creatorVault.toBase58());
    const [userVolumeAccumulator] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_volume_accumulator"), buyer.toBuffer()],
        PUMP_FUN_PROGRAM
    );

    console.log('🔍 Creator Vault Calculation:', {
        creator: creator.toBase58(),
        mint: mint.toBase58(),
        calculatedVault: creatorVault.toBase58(),
        seeds: ['vault', creator.toBase58(), mint.toBase58()]
    });

    const keys = [
        { pubkey: PUMP_FUN_GLOBAL, isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_FEE_RECIPIENT, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedUser, isSigner: false, isWritable: true },
        { pubkey: buyer, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: creatorVault, isSigner: false, isWritable: true },
        { pubkey: PUMP_FUN_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_GLOBAL_VOLUME, isSigner: false, isWritable: true },
        { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
        { pubkey: PUMP_FUN_FEE_CONFIG, isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_FEES_PROGRAM, isSigner: false, isWritable: false }
    ];

    return new TransactionInstruction({
        keys,
        programId: PUMP_FUN_PROGRAM,
        data
    });
}

/**
 * Debug function to verify creator vault calculation
 */
async function debugCreatorVaultCalculation(tokenAddress, bondingCurveAddress) {
    try {
        console.log('\n🔍 DEBUG: Creator Vault Calculation');
        console.log('================================');

        // Get bonding curve data to extract creator
        const { creator } = await getBondingCurveData(connection, new PublicKey(bondingCurveAddress));
        console.log(`Creator from bonding curve: ${creator.toBase58()}`);

        // Calculate creator vault
        const [creatorVault] = PublicKey.findProgramAddressSync(
            [Buffer.from("vault"), creator.toBuffer(), new PublicKey(tokenAddress).toBuffer()],
            PUMP_FUN_PROGRAM
        );

        console.log(`Calculated creator vault: ${creatorVault.toBase58()}`);
        console.log('Seeds used: ["vault", creator, mint]');
        console.log('================================\n');

        return { creator: creator.toBase58(), creatorVault: creatorVault.toBase58() };
    } catch (error) {
        console.error('Debug failed:', error);
        return null;
    }
}

/**
 * Direct buy function - uses bonding curve from websocket
 */

async function getBondingCurveState(connection, bondingCurve) {
    try {
        const accountInfo = await connection.getAccountInfo(bondingCurve);
        if (!accountInfo) {
            throw new Error('Bonding curve account not found');
        }

        const data = accountInfo.data;

        // Read the bonding curve reserves using little-endian format
        const virtualTokenReserves = data.readBigUInt64LE(8);
        const virtualSolReserves = data.readBigUInt64LE(16);
        const realTokenReserves = data.readBigUInt64LE(24);
        const realSolReserves = data.readBigUInt64LE(32);

        // Extract creator (at offset 49, 32 bytes)
        const creator = new PublicKey(data.slice(49, 49 + 32));

        console.log('📊 Bonding Curve State:', {
            virtualTokenReserves: virtualTokenReserves.toString(),
            virtualSolReserves: virtualSolReserves.toString(),
            realTokenReserves: realTokenReserves.toString(),
            realSolReserves: realSolReserves.toString(),
            creator: creator.toBase58()
        });

        return {
            virtualTokenReserves,
            virtualSolReserves,
            realTokenReserves,
            realSolReserves,
            creator
        };
    } catch (error) {
        console.error('Error reading bonding curve state:', error);
        throw error;
    }
}

function calculateTokensFromSol(solAmount, bondingCurveState) {
    const { virtualTokenReserves, virtualSolReserves } = bondingCurveState;

    // Convert SOL to lamports (BigInt for precision)
    const solAmountLamports = BigInt(Math.floor(solAmount * LAMPORTS_PER_SOL));

    // Constant product formula: dy = (y * dx) / (x + dx)
    // where: y = token reserves, x = sol reserves, dx = sol input
    const numerator = virtualTokenReserves * solAmountLamports;
    const denominator = virtualSolReserves + solAmountLamports;
    const tokensOut = numerator / denominator;

    console.log('🧮 Token Calculation:', {
        solInput: `${solAmount} SOL (${solAmountLamports} lamports)`,
        tokenReserves: virtualTokenReserves.toString(),
        solReserves: virtualSolReserves.toString(),
        tokensOut: tokensOut.toString(),
        tokensOutFormatted: (Number(tokensOut) / 1e6).toFixed(2) + 'M tokens'
    });

    return tokensOut;
}

function calculateMaxSolCost(desiredSolAmount, slippageBps = 1000) {
    const lamports = Math.floor(desiredSolAmount * LAMPORTS_PER_SOL);
    const slippageMultiplier = 1 + (slippageBps / 10000);
    const maxSolCost = Math.floor(lamports * slippageMultiplier);

    console.log('💰 Max SOL Cost Calculation:', {
        desiredSol: `${desiredSolAmount} SOL`,
        desiredLamports: lamports,
        slippage: `${slippageBps / 100}%`,
        maxSolCost: maxSolCost,
        maxSolCostSOL: (maxSolCost / LAMPORTS_PER_SOL).toFixed(6)
    });

    return maxSolCost;
}

async function executeDirectBondingCurveBuy(params) {
    const startTime = Date.now();

    console.log('\n' + '🎯'.repeat(40));
    console.log('SAFE SOL BUDGET BUY - PARAMETERS:');
    console.log(`   Desired SOL Spend: ${params.amount} SOL`);
    console.log(`   Slippage: ${params.slippage}%`);
    console.log(`   Priority Fee: ${params.priorityFee} SOL`);
    console.log('🎯'.repeat(40) + '\n');

    // ✅ ADD VALIDATION FOR PRIORITY FEE
    if (!params.priorityFee || params.priorityFee === undefined || params.priorityFee === null) {
        console.log('⚠️ Priority Fee is undefined, using default value: 0.0005 SOL');
        params.priorityFee = 0.0005; // Default fallback value
    }

    // ✅ ENSURE PRIORITY FEE IS A VALID NUMBER
    if (typeof params.priorityFee !== 'number' || isNaN(params.priorityFee)) {
        console.log('⚠️ Priority Fee is not a valid number, using default: 0.0005 SOL');
        params.priorityFee = 0.0005;
    }

    // ✅ ENSURE PRIORITY FEE IS POSITIVE
    if (params.priorityFee < 0) {
        console.log('⚠️ Priority Fee is negative, using default: 0.0005 SOL');
        params.priorityFee = 0.0005;
    }

    console.log(`✅ FINAL Priority Fee: ${params.priorityFee} SOL`);

    try {
        // Skip balance check - let transaction fail naturally if insufficient balance

        const wallet = Keypair.fromSecretKey(bs58.decode(botState.settings.privateKey));
        const buyer = wallet.publicKey;

        const mint = new PublicKey(params.mint);
        const bondingCurve = new PublicKey(params.bondingCurveAddress);

        console.log(`🎯 Token: ${mint.toBase58()}`);
        console.log(`📊 Bonding Curve: ${bondingCurve.toBase58()}`);

        // ✅ STEP 1: READ BONDING CURVE STATE
        console.log('\n📖 STEP 1: Reading bonding curve state...');
        const bondingCurveState = await getBondingCurveState(connection, bondingCurve);
        const creator = bondingCurveState.creator;
        console.log(`👤 Creator: ${creator.toBase58()}`);

        // ✅ STEP 2: CALCULATE TOKENS FROM DESIRED SOL AMOUNT
        console.log('\n🧮 STEP 2: Calculating tokens for SOL amount...');
        const tokensToReceive = calculateTokensFromSol(params.amount, bondingCurveState);
        console.log(`✅ Expected tokens: ${tokensToReceive.toString()}`);

        // ✅ STEP 3: CALCULATE MAX SOL COST WITH SLIPPAGE
        console.log('\n💸 STEP 3: Calculating max SOL cost with slippage...');
        const maxSolCost = calculateMaxSolCost(params.amount, params.slippage);
        console.log(`✅ Max SOL cost: ${maxSolCost} lamports (${(maxSolCost / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);

        // ✅ STEP 4: SETUP TRANSACTION (NO BALANCE CHECK)
        console.log('\n🔨 STEP 4: Setting up transaction...');

        const [creatorVault] = PublicKey.findProgramAddressSync(
            [Buffer.from("creator-vault"), creator.toBuffer()],
            PUMP_FUN_PROGRAM
        );
        console.log(`🔐 Creator Vault: ${creatorVault.toBase58()}`);

        const associatedBondingCurve = getAssociatedBondingCurveAddress(bondingCurve, mint);
        const associatedUser = await getAssociatedTokenAddress(mint, buyer);

        const transaction = new Transaction();

        // ✅ VALIDATE AND CONVERT PRIORITY FEE TO LAMPORTS
        let priorityFeeLamports;
        try {
            priorityFeeLamports = Math.floor(params.priorityFee * LAMPORTS_PER_SOL);
            console.log(`⚡ Priority Fee: ${priorityFeeLamports} lamports (${params.priorityFee} SOL)`);

            if (isNaN(priorityFeeLamports) || priorityFeeLamports < 0) {
                throw new Error(`Invalid priority fee value: ${params.priorityFee}`);
            }
        } catch (error) {
            console.error('❌ Error converting priority fee:', error);
            throw new Error(`Invalid priority fee value: ${params.priorityFee}`);
        }

        // Priority Fee
        const COMPUTE_UNITS = 200000;
        const microLamports = Math.floor((priorityFeeLamports * 1000000) / COMPUTE_UNITS);

        console.log(`⚡ Priority Fee: ${priorityFeeLamports} lamports (${microLamports} microLamports per CU)`);

        transaction.add(
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports })
        );

        transaction.add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS })
        );

        // Check if ATA needs to be created
        const accountInfo = await connection.getAccountInfo(associatedUser);
        const needsATACreation = !accountInfo;
        const ataCreationCost = needsATACreation ? 2039280 : 0;

        if (needsATACreation) {
            console.log('🔓 Creating associated token account...');
            console.log(`   ATA Creation Cost: ${ataCreationCost} lamports (${(ataCreationCost / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);
            transaction.add(
                createAssociatedTokenAccountInstruction(
                    buyer,
                    associatedUser,
                    buyer,
                    mint
                )
            );
        }

        // Calculate estimated cost (for logging only - no validation)
        const networkBaseFee = 5000;
        const totalTransactionCost = maxSolCost + priorityFeeLamports + ataCreationCost + networkBaseFee;
        const totalTransactionCostSOL = totalTransactionCost / LAMPORTS_PER_SOL;

        console.log('\n' + '📊'.repeat(40));
        console.log('ESTIMATED TRANSACTION COST:');
        console.log(`   Max Buy Cost:         ${maxSolCost.toLocaleString()} lamports (${(maxSolCost / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);
        console.log(`   Priority Fee:         ${priorityFeeLamports.toLocaleString()} lamports (${(priorityFeeLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);
        console.log(`   ATA Creation:         ${ataCreationCost.toLocaleString()} lamports (${(ataCreationCost / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);
        console.log(`   Network Base Fee:     ${networkBaseFee.toLocaleString()} lamports (${(networkBaseFee / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);
        console.log(`   ${'─'.repeat(76)}`);
        console.log(`   ESTIMATED TOTAL:      ${totalTransactionCost.toLocaleString()} lamports (${totalTransactionCostSOL.toFixed(6)} SOL)`);
        console.log('📊'.repeat(40));
        console.log('⚠️ Balance check SKIPPED - transaction will be sent regardless\n');

        // ✅ STEP 5: ADD BUY INSTRUCTION WITH CALCULATED VALUES
        console.log('\n🔨 STEP 5: Creating buy instruction...');
        console.log(`   Token Amount: ${tokensToReceive.toString()}`);
        console.log(`   Max SOL Cost: ${maxSolCost} lamports`);

        transaction.add(
            createPumpFunBuyInstruction(
                buyer,
                mint,
                bondingCurve,
                associatedBondingCurve,
                associatedUser,
                creator,
                tokensToReceive,  // ✅ Calculated tokens from bonding curve
                maxSolCost        // ✅ Max SOL with slippage protection
            )
        );

        // Get fresh blockhash
        console.log('\n⏳ Getting fresh blockhash...');
        let blockhash, lastValidBlockHeight;
        let retryCount = 0;
        const maxRetries = 3;

        while (retryCount < maxRetries) {
            try {
                const blockhashInfo = await connection.getLatestBlockhash('finalized');
                blockhash = blockhashInfo.blockhash;
                lastValidBlockHeight = blockhashInfo.lastValidBlockHeight;
                console.log(`✅ Got fresh blockhash (attempt ${retryCount + 1})`);
                break;
            } catch (error) {
                retryCount++;
                if (retryCount >= maxRetries) {
                    throw new Error('Failed to get blockhash after multiple attempts');
                }
                console.log(`⚠️ Blockhash attempt ${retryCount} failed, retrying...`);
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        transaction.recentBlockhash = blockhash;
        transaction.lastValidBlockHeight = lastValidBlockHeight;
        transaction.feePayer = buyer;

        // Sign transaction
        transaction.sign(wallet);

        console.log('\n📤 Sending transaction to Solana network...');
        const signature = await connection.sendRawTransaction(transaction.serialize(), {
            skipPreflight: true,
            maxRetries: 0
        });

        console.log(`✅ Transaction sent! Signature: ${signature}`);
        console.log(`🔗 Explorer: https://solscan.io/tx/${signature}`);

        const executionTime = Date.now() - startTime;
        console.log('\n' + '='.repeat(80));
        console.log('✅ SAFE SOL BUDGET BUY COMPLETE');
        console.log('='.repeat(80));
        console.log(`⏱️ Total execution time: ${executionTime}ms`);
        console.log(`💰 SOL Budgeted: ${params.amount} SOL`);
        console.log(`💰 Max SOL (with slippage): ${(maxSolCost / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
        console.log(`⚡ Priority Fee: ${params.priorityFee} SOL`);
        console.log(`🪙 Expected Tokens: ${(Number(tokensToReceive) / 1e6).toFixed(2)}M tokens`);
        console.log(`🔖 Signature: ${signature}`);
        console.log('='.repeat(80) + '\n');

        return {
            signature: signature,
            expectedTokens: tokensToReceive.toString(),
            maxSolCost: maxSolCost,
            actualSolSpent: 'pending_confirmation',
            confirmationPromise: connection.confirmTransaction(signature, 'processed')
        };

    } catch (error) {
        const executionTime = Date.now() - startTime;
        console.error('\n' + '='.repeat(80));
        console.error('❌ SAFE SOL BUDGET BUY FAILED');
        console.error('='.repeat(80));
        console.error(`⏱️ Failed after: ${executionTime}ms`);
        console.error('Error Message:', error.message);
        console.error('Error Stack:', error.stack);
        console.error('='.repeat(80) + '\n');
        throw error;
    }
}

async function fetchTokenMetadata(tokenData) {
    console.log('🔍 Starting metadata fetch for token...');
    console.log(`  Token Address: ${tokenData.mint || tokenData.id || 'Unknown'}`);
    console.log(`  Platform (raw): ${tokenData.platform || 'Unknown'}`);

    // ✅ FIX: Normalize platform - remove dots
    const platform = tokenData.platform ? tokenData.platform.replace('.', '').toLowerCase() : null;
    console.log(`  Platform (normalized): ${platform || 'Unknown'}`);

    // ✅ FIX: Check both 'uri' and 'metadataUri' fields
    const ipfsUri = tokenData.uri || tokenData.metadataUri;
    console.log(`  Has URI: ${!!ipfsUri}`);
    console.log(`  URI: ${ipfsUri || 'None'}`);

    try {
        // ✅ FIX: Check for normalized 'pumpfun'
        const isPumpFun = platform === 'pumpfun';

        console.log(`  Is Pump.fun token: ${isPumpFun}`);

        // For Pump.fun tokens, use IPFS gateway racing
        if (isPumpFun && ipfsUri) {
            console.log('🎯 Pump.fun token detected, using IPFS gateway racing...');
            console.log(`🌐 IPFS URI: ${ipfsUri}`);

            const metadata = await fetchIPFSFastest(ipfsUri);

            if (metadata) {
                console.log('✅ IPFS metadata fetched successfully:');
                console.log(`  Name: ${metadata.name || 'N/A'}`);
                console.log(`  Symbol: ${metadata.symbol || 'N/A'}`);
                console.log(`  Description: ${metadata.description?.substring(0, 50) || 'N/A'}...`);
                console.log(`  Has Twitter: ${!!metadata.twitter}`);
                console.log(`  Twitter: ${metadata.twitter || 'None'}`);
                console.log(`  Has Website: ${!!metadata.website}`);
                console.log(`  Website: ${metadata.website || 'None'}`);
                console.log(`  Has Telegram: ${!!metadata.telegram}`);
                console.log(`  Telegram: ${metadata.telegram || 'None'}`);

                return {
                    name: metadata.name || tokenData.name || 'Unknown',
                    symbol: metadata.symbol || tokenData.symbol || 'UNKNOWN',
                    description: metadata.description,
                    imageUrl: metadata.image,
                    website: metadata.website,
                    twitterHandle: metadata.twitter,  // ✅ This will be "https://x.com/radiancebrr"
                    telegram: metadata.telegram,
                    hasEnhancedData: true,
                    isBonkToken: false,
                    source: 'ipfs_gateway_racing'
                };
            } else {
                console.log('⚠️ IPFS fetch returned null - all gateways failed');
            }
        } else {
            console.log(`⚠️ Skipping IPFS fetch:`);
            console.log(`  isPumpFun: ${isPumpFun} (requires 'pumpfun')`);
            console.log(`  hasIpfsUri: ${!!ipfsUri}`);
            console.log(`  Both required: ${isPumpFun && !!ipfsUri}`);
        }

        // For Bonk tokens, use enhanced metadata fetching
        const isBonk = platform === 'letsbonk';
        if (isBonk) {
            console.log('🦎 Bonk token detected, using enhanced metadata fetch...');
            const metadata = await fetchEnhancedBonkMetadata(tokenData.mint, tokenData);

            if (metadata) {
                console.log('✅ Enhanced Bonk metadata fetched:', {
                    name: metadata.name,
                    symbol: metadata.symbol,
                    hasTwitter: !!metadata.twitterUrl,
                    twitter: metadata.twitterUrl || 'None'
                });
                return metadata;
            }
        }

        // Fallback to basic metadata
        console.log('⚠️ Using fallback metadata (no IPFS/enhanced fetch available)');
        console.log(`  Reason: ${!platform ? 'No platform specified' :
            !isPumpFun && !isBonk ? `Platform "${platform}" not recognized (expecting 'pumpfun' or 'letsbonk')` :
                isPumpFun && !ipfsUri ? 'Pump.fun token but no IPFS URI' :
                    isBonk ? 'Bonk enhanced fetch failed' :
                        'Unknown reason'
            }`);

        return {
            name: tokenData.name || `Token ${(tokenData.mint || tokenData.id || 'Unknown').slice(0, 8)}`,
            symbol: tokenData.symbol || 'TOKEN',
            description: null,
            imageUrl: ipfsUri || tokenData.image || null,
            website: null,
            twitterHandle: null,
            hasEnhancedData: false,
            isBonkToken: isBonk,
            source: 'fallback'
        };

    } catch (error) {
        console.error('❌ Error fetching token metadata:', error);
        console.error('  Error message:', error.message);

        return {
            name: tokenData.name || 'Unknown',
            symbol: tokenData.symbol || 'UNKNOWN',
            description: null,
            imageUrl: ipfsUri || tokenData.image || null,
            website: null,
            twitterHandle: null,
            hasEnhancedData: false,
            isBonkToken: platform === 'letsbonk',
            source: 'error_fallback',
            error: error.message
        };
    }
}

async function checkIfPumpFunToken(tokenAddress) {
    try {
        // Simple check - if it's 44 characters and base58, likely a Solana token
        return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tokenAddress);
    } catch (error) {
        return false;
    }
}

app.get('/api/pair-address/:tokenAddress', async (req, res) => {
    // START MASTER TIMING - Request begins
    const requestStartTime = Date.now();

    try {
        const { tokenAddress } = req.params;

        if (!tokenAddress) {
            return res.status(400).json({ error: 'Token address is required' });
        }

        console.log(`🔍 Getting address for token: ${tokenAddress}`);

        // 🔥 FIRST: Check if we have the bonding curve stored from detection
        const detectedToken = botState.detectedTokens.get(tokenAddress);
        const masterStartTime = detectedToken?.masterStartTime;
        const storageCheckTime = Date.now();
        const storageCheckDuration = storageCheckTime - requestStartTime;

        // Log timing from initial detection if available
        if (masterStartTime) {
            const totalFromDetection = requestStartTime - masterStartTime;
            console.log(`⏱️ API REQUEST TIMING:`);
            console.log(`   - Time from initial detection to API request: ${totalFromDetection}ms`);
            console.log(`   - Storage check duration: ${storageCheckDuration}ms`);
        }

        if (detectedToken && detectedToken.bondingCurveAddress) {
            const responseTime = Date.now();
            const requestDuration = responseTime - requestStartTime;
            const totalFromDetection = masterStartTime ? responseTime - masterStartTime : requestDuration;

            console.log(`✅ Found stored bonding curve: ${detectedToken.bondingCurveAddress}`);
            console.log(`⏱️ STORED BONDING CURVE RESPONSE TIMING:`);
            console.log(`   - Storage lookup: ${storageCheckDuration}ms`);
            console.log(`   - Total request duration: ${requestDuration}ms`);

            if (masterStartTime) {
                console.log(`   - Detection to processing: ${detectedToken.detectionToProcessing || 'N/A'}ms`);
                console.log(`   - Processing duration: ${detectedToken.processingTime || 'N/A'}ms`);
                console.log(`   - TOTAL: Detection to API response: ${totalFromDetection}ms`);
            }

            res.json({
                success: true,
                tokenAddress,
                bondingCurveData: {
                    bondingCurveAddress: detectedToken.bondingCurveAddress,
                    type: 'pump_fun_bonding_curve',
                    source: 'stored_from_detection'
                },
                axiomUrl: `https://axiom.trade/meme/${detectedToken.bondingCurveAddress}`,
                fallbackAxiomUrl: `https://axiom.trade/meme/${tokenAddress}`,
                isPumpFun: true,
                timing: {
                    requestDuration,
                    storageCheckDuration,
                    totalFromDetection,
                    detectionToProcessing: detectedToken.detectionToProcessing,
                    processingTime: detectedToken.processingTime,
                    masterStartTime,
                    source: 'stored_bonding_curve'
                }
            });
            return;
        }

        // Check if this is a pump.fun token (ends with 'pump' or detected as pump.fun)
        const tokenTypeCheckStart = Date.now();
        const isPumpFunToken = tokenAddress.endsWith('pump') || await checkIfPumpFunToken(tokenAddress);
        const tokenTypeCheckTime = Date.now() - tokenTypeCheckStart;

        console.log(`🔍 Token type check duration: ${tokenTypeCheckTime}ms (isPumpFun: ${isPumpFunToken})`);

        if (isPumpFunToken) {
            try {
                // TIMING CHECKPOINT - Before bonding curve calculation
                const bondingCurveStartTime = Date.now();
                const elapsedToCalculation = bondingCurveStartTime - requestStartTime;

                console.log(`🎯 Pump.fun token detected, calculating bonding curve address as fallback`);
                console.log(`⏱️ Time to calculation start: ${elapsedToCalculation}ms`);

                const { PublicKey } = require('@solana/web3.js');
                const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

                const mintPublicKey = new PublicKey(tokenAddress);
                const [bondingCurve] = PublicKey.findProgramAddressSync(
                    [Buffer.from("bonding-curve"), mintPublicKey.toBytes()],
                    PUMP_FUN_PROGRAM
                );

                // TIMING CHECKPOINT - After bonding curve calculation
                const bondingCurveEndTime = Date.now();
                const calculationTime = bondingCurveEndTime - bondingCurveStartTime;
                const totalElapsedTime = bondingCurveEndTime - requestStartTime;
                const totalFromDetection = masterStartTime ? bondingCurveEndTime - masterStartTime : totalElapsedTime;

                console.log(`✅ Calculated bonding curve as fallback: ${bondingCurve.toString()}`);
                console.log(`⏱️ BONDING CURVE CALCULATION TIMING:`);
                console.log(`   - Storage check: ${storageCheckDuration}ms`);
                console.log(`   - Token type check: ${tokenTypeCheckTime}ms`);
                console.log(`   - Time to calculation start: ${elapsedToCalculation}ms`);
                console.log(`   - Bonding curve calculation: ${calculationTime}ms`);
                console.log(`   - Total request duration: ${totalElapsedTime}ms`);

                if (masterStartTime) {
                    console.log(`   - TOTAL: Detection to bonding curve ready: ${totalFromDetection}ms`);
                }

                res.json({
                    success: true,
                    tokenAddress,
                    bondingCurveData: {
                        bondingCurveAddress: bondingCurve.toString(),
                        type: 'pump_fun_bonding_curve',
                        source: 'calculated_fallback'
                    },
                    axiomUrl: `https://axiom.trade/meme/${bondingCurve.toString()}`,
                    fallbackAxiomUrl: `https://axiom.trade/meme/${tokenAddress}`,
                    isPumpFun: true,
                    timing: {
                        storageCheckDuration,
                        tokenTypeCheckTime,
                        elapsedToCalculation,
                        calculationTime,
                        totalElapsedTime,
                        totalFromDetection,
                        masterStartTime,
                        source: 'calculated_bonding_curve'
                    }
                });

            } catch (error) {
                const errorTime = Date.now();
                const totalErrorTime = errorTime - requestStartTime;
                const totalFromDetection = masterStartTime ? errorTime - masterStartTime : totalErrorTime;

                console.error(`❌ Error calculating bonding curve (Time elapsed: ${totalErrorTime}ms):`, error);

                res.json({
                    success: false,
                    tokenAddress,
                    message: 'Failed to get bonding curve address',
                    fallbackAxiomUrl: `https://axiom.trade/meme/${tokenAddress}`,
                    isPumpFun: true,
                    error: error.message,
                    timing: {
                        totalErrorTime,
                        totalFromDetection,
                        masterStartTime,
                        source: 'bonding_curve_error'
                    }
                });
            }
        } else {
            // For non-pump.fun tokens, use the existing pair address logic
            const dexScreenerStartTime = Date.now();
            const elapsedToDexScreener = dexScreenerStartTime - requestStartTime;

            console.log(`🔍 Non-pump token detected, fetching from DexScreener`);
            console.log(`⏱️ Time to DexScreener start: ${elapsedToDexScreener}ms`);

            const pairData = await getPairAddressFromDexScreener(tokenAddress);

            const dexScreenerEndTime = Date.now();
            const dexScreenerTime = dexScreenerEndTime - dexScreenerStartTime;
            const totalElapsedTime = dexScreenerEndTime - requestStartTime;
            const totalFromDetection = masterStartTime ? dexScreenerEndTime - masterStartTime : totalElapsedTime;

            if (pairData) {
                console.log(`✅ Found pair data: ${pairData.pairAddress}`);
                console.log(`⏱️ DEXSCREENER PAIR LOOKUP TIMING:`);
                console.log(`   - Storage check: ${storageCheckDuration}ms`);
                console.log(`   - Token type check: ${tokenTypeCheckTime}ms`);
                console.log(`   - Time to DexScreener start: ${elapsedToDexScreener}ms`);
                console.log(`   - DexScreener API call: ${dexScreenerTime}ms`);
                console.log(`   - Total request duration: ${totalElapsedTime}ms`);

                if (masterStartTime) {
                    console.log(`   - TOTAL: Detection to pair address ready: ${totalFromDetection}ms`);
                }

                res.json({
                    success: true,
                    tokenAddress,
                    pairData,
                    axiomUrl: `https://axiom.trade/meme/${pairData.pairAddress}`,
                    fallbackAxiomUrl: `https://axiom.trade/meme/${tokenAddress}`,
                    isPumpFun: false,
                    timing: {
                        storageCheckDuration,
                        tokenTypeCheckTime,
                        elapsedToDexScreener,
                        dexScreenerTime,
                        totalElapsedTime,
                        totalFromDetection,
                        masterStartTime,
                        source: 'dexscreener_pair'
                    }
                });
            } else {
                const totalElapsedTime = Date.now() - requestStartTime;
                const totalFromDetection = masterStartTime ? Date.now() - masterStartTime : totalElapsedTime;

                console.log(`❌ No pair found for token: ${tokenAddress}`);
                console.log(`⏱️ NO PAIR FOUND TIMING:`);
                console.log(`   - Storage check: ${storageCheckDuration}ms`);
                console.log(`   - Token type check: ${tokenTypeCheckTime}ms`);
                console.log(`   - DexScreener call: ${dexScreenerTime}ms`);
                console.log(`   - Total request duration: ${totalElapsedTime}ms`);

                if (masterStartTime) {
                    console.log(`   - TOTAL: Detection to no-pair response: ${totalFromDetection}ms`);
                }

                res.json({
                    success: false,
                    tokenAddress,
                    message: 'No pair found for this token',
                    fallbackAxiomUrl: `https://axiom.trade/meme/${tokenAddress}`,
                    isPumpFun: false,
                    timing: {
                        storageCheckDuration,
                        tokenTypeCheckTime,
                        dexScreenerTime,
                        totalElapsedTime,
                        totalFromDetection,
                        masterStartTime,
                        source: 'no_pair_found'
                    }
                });
            }
        }
    } catch (error) {
        const errorTime = Date.now();
        const totalErrorTime = errorTime - requestStartTime;
        const detectedToken = botState.detectedTokens.get(req.params.tokenAddress);
        const masterStartTime = detectedToken?.masterStartTime;
        const totalFromDetection = masterStartTime ? errorTime - masterStartTime : totalErrorTime;

        console.error(`❌ Error in pair-address endpoint:`);
        console.error(`   - Error: ${error.message}`);
        console.error(`   - Total request time: ${totalErrorTime}ms`);

        if (masterStartTime) {
            console.error(`   - TOTAL: Detection to error: ${totalFromDetection}ms`);
        }

        res.status(500).json({
            success: false,
            error: error.message,
            fallbackAxiomUrl: `https://axiom.trade/meme/${req.params.tokenAddress}`,
            timing: {
                totalErrorTime,
                totalFromDetection,
                masterStartTime,
                source: 'endpoint_error'
            }
        });
    }
});

// Find the snipeToken function in server.js and update it

async function snipeToken(tokenAddress, config) {
    const snipeStartTime = Date.now();

    console.log('\n' + '🔥'.repeat(40));
    console.log('🎯 SNIPE TOKEN INITIATED');
    console.log('🔥'.repeat(40));
    console.log(`📋 CONFIG DEBUG:`);
    console.log(`   config.amount type: ${typeof config.amount}`);
    console.log(`   config.amount value: ${config.amount}`);
    console.log(`   config.fees type: ${typeof config.fees}`);
    console.log(`   config.fees value: ${config.fees}`);
    console.log(`   config.priorityFee type: ${typeof config.priorityFee}`);
    console.log(`   config.priorityFee value: ${config.priorityFee}`);
    console.log(`   Expected: Should be in SOL (e.g., 0.00099)`);
    console.log('🔥'.repeat(40));
    console.log(`🏷️ Token Address: ${tokenAddress}`);
    console.log(`💰 Amount: ${config.amount} SOL`);
    console.log(`⚙️ Slippage: ${config.fees}%`);
    console.log(`🛡️ MEV Protection: ${config.mevProtection ? 'ENABLED' : 'DISABLED'}`);
    console.log(`⚡ Priority Fee: ${config.priorityFee} SOL (from individual admin)`);
    console.log('🔥'.repeat(40) + '\n');

    // ✅ VALIDATE CONFIGURATION
    if (!config.amount || typeof config.amount !== 'number' || config.amount <= 0) {
        console.error('❌ Invalid snipe amount:', config.amount);
        throw new Error(`Invalid snipe amount: ${config.amount}. Must be a positive number in SOL.`);
    }

    if (!config.fees || typeof config.fees !== 'number') {
        console.error('❌ Invalid fees/slippage:', config.fees);
        throw new Error(`Invalid fees: ${config.fees}. Must be a number.`);
    }

    // ✅ VALIDATE PRIORITY FEE
    if (!config.priorityFee || typeof config.priorityFee !== 'number' || config.priorityFee < 0) {
        console.log('⚠️ Priority Fee is invalid, using default: 0.0005 SOL');
        config.priorityFee = 0.0005;
    }

    console.log('✅ Configuration validated:', {
        amount: `${config.amount} SOL`,
        fees: `${config.fees}%`,
        priorityFee: `${config.priorityFee} SOL`,
        mevProtection: config.mevProtection
    });

    try {
        console.log('🏁 Checking wallet balance...');
        /*  const hasBalance = await checkWalletBalance();
          if (!hasBalance) {
              throw new Error('Insufficient wallet balance - need at least 0.01 SOL');
          } */

        const detectedToken = botState.detectedTokens.get(tokenAddress);
        let bondingCurveAddress = detectedToken?.bondingCurveAddress;
        let creatorWallet = detectedToken?.creatorWallet;

        if (!bondingCurveAddress) {
            console.log('⚠️ WARNING: No bonding curve from websocket, calculating...');
            const { PublicKey } = require('@solana/web3.js');
            const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
            const mintPublicKey = new PublicKey(tokenAddress);
            const [bondingCurve] = PublicKey.findProgramAddressSync(
                [Buffer.from("bonding-curve"), mintPublicKey.toBytes()],
                PUMP_FUN_PROGRAM
            );
            bondingCurveAddress = bondingCurve.toString();
        }

        if (!creatorWallet) {
            throw new Error('Creator wallet not found - cannot calculate creator vault');
        }

        console.log(`📊 Using bonding curve: ${bondingCurveAddress}`);
        console.log(`👤 Using creator: ${creatorWallet}`);

        // ✅ PASS THE VALIDATED CONFIG TO PARAMS
        const params = {
            mint: tokenAddress,
            bondingCurveAddress: bondingCurveAddress,
            creatorWallet: creatorWallet,
            amount: config.amount,
            priorityFee: config.priorityFee, // ✅ Now guaranteed to be valid
            slippage: config.fees * 100
        };

        console.log('📋 Trade Parameters:', JSON.stringify(params, null, 2));
        console.log(`⚡ Final Priority Fee: ${params.priorityFee} SOL (validated)`);

        console.log('🚀 Executing direct bonding curve buy...');
        const tradeStartTime = Date.now();

        const tradeResult = await executeDirectBondingCurveBuy(params);

        const tradeEndTime = Date.now() - tradeStartTime;
        const tradeExecutionTime = tradeEndTime - tradeStartTime;

        console.log(`⏱️ Trade execution time: ${tradeExecutionTime}ms`);
        console.log(`✅ Transaction signature: ${tradeResult.signature}`);

        console.log('🌐 Generating token page URL...');
        const tokenPageUrl = await getTokenPageUrl(
            tokenAddress,
            botState.settings.tokenPageDestination,
            detectedToken?.platform
        );

        const totalTime = Date.now() - snipeStartTime;

        console.log('\n' + '✅'.repeat(40));
        console.log('SNIPE COMPLETED SUCCESSFULLY');
        console.log('✅'.repeat(40));
        console.log(`⏱️ Snipe execution time: ${totalTime}ms`);
        console.log(`🔖 Signature: ${tradeResult.signature}`);
        console.log(`🔗 Explorer: https://solscan.io/tx/${tradeResult.signature}`);
        console.log(`🌐 Token page: ${tokenPageUrl}`);
        console.log('✅'.repeat(40) + '\n');

        broadcastToClients({
            type: 'snipe_success',
            data: {
                tokenAddress,
                signature: tradeResult.signature,
                amount: config.amount,
                priorityFee: config.priorityFee,
                tokenPageUrl,
                timestamp: new Date().toISOString(),
                openTokenPage: true,
                destination: botState.settings.tokenPageDestination,
                status: tradeResult.confirmed ? 'confirmed' : 'pending',
                explorerUrl: `https://solscan.io/tx/${tradeResult.signature}`,
                timing: {
                    snipeExecution: totalTime,
                    tradeExecution: tradeExecutionTime
                }
            }
        });

        return {
            success: true,
            signature: tradeResult.signature,
            confirmed: tradeResult.confirmed,
            tokenPageUrl,
            status: tradeResult.confirmed ? 'Transaction confirmed' : 'Transaction pending',
            explorerUrl: `https://solscan.io/tx/${tradeResult.signature}`
        };

    } catch (error) {
        console.error('\n' + '❌'.repeat(40));
        console.error('SNIPE FAILED');
        console.error('❌'.repeat(40));
        console.error('Error:', error.message);
        console.error('Stack:', error.stack);
        console.error('❌'.repeat(40) + '\n');

        broadcastToClients({
            type: 'snipe_error',
            data: {
                tokenAddress,
                error: error.message,
                timestamp: new Date().toISOString()
            }
        });

        throw error;
    }
}

// Ensure token timing logs directory exists
try {
    if (!fs.existsSync(TOKEN_TIMING_LOGS_DIR)) {
        fs.mkdirSync(TOKEN_TIMING_LOGS_DIR, { recursive: true });
        console.log('📁 Token timing logs directory created');
    }
} catch (error) {
    console.error('Error creating token timing logs directory:', error);
}

// Simple token log file creator
function createTokenLogFile(tokenAddress, tokenName, tokenSymbol) {
    const sanitizedName = (tokenName || 'Unknown').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').substring(0, 50);
    const sanitizedSymbol = (tokenSymbol || 'TOKEN').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').substring(0, 10);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    const filename = `${timestamp}_${sanitizedSymbol}_${sanitizedName}_${tokenAddress.substring(0, 8)}.txt`;
    return path.join(TOKEN_TIMING_LOGS_DIR, filename);
}

// Store active token log files
const activeTokenLogs = new Map();

function logToTokenFile(tokenAddress, message) {
    const logPath = activeTokenLogs.get(tokenAddress);
    if (logPath) {
        try {
            // Strip ANSI color codes
            const cleanMessage = message.replace(/\x1b\[[0-9;]*m/g, '');
            fs.appendFileSync(logPath, cleanMessage + '\n');
        } catch (error) {
            console.error('Error writing to token log:', error);
        }
    }
}

app.get('/api/verify-pump-portal-config', (req, res) => {
    const hasApiKey = !!PUMP_PORTAL_API_KEY;
    const keyPreview = hasApiKey ? `${PUMP_PORTAL_API_KEY.substring(0, 10)}...` : 'NOT SET';

    console.log('🔍 Pump Portal Configuration Check:');
    console.log(`  API Key Present: ${hasApiKey}`);
    console.log(`  API Key Preview: ${keyPreview}`);

    res.json({
        success: true,
        configured: hasApiKey,
        apiKeyPreview: keyPreview,
        message: hasApiKey
            ? 'Pump Portal API key is configured'
            : 'WARNING: Pump Portal API key is missing! Add PUMP_PORTAL_API_KEY to .env file'
    });
});

// ✅ Add test endpoint to verify trade execution
app.post('/api/test-pump-portal-connection', async (req, res) => {
    try {
        if (!PUMP_PORTAL_API_KEY) {
            return res.status(400).json({
                success: false,
                error: 'Pump Portal API key not configured'
            });
        }

        console.log('🧪 Testing Pump Portal API connection...');

        // Just test the API endpoint availability
        const testUrl = `https://pumpportal.fun/api/trade?api-key=${PUMP_PORTAL_API_KEY}`;

        const response = await fetch(testUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: "buy",
                mint: "test", // Invalid mint for testing
                amount: 0.001,
                denominatedInSol: "true"
            })
        });

        const data = await response.text();

        res.json({
            success: true,
            message: 'Pump Portal API is reachable',
            statusCode: response.status,
            response: data.substring(0, 200) // First 200 chars
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Add this function to check wallet balance
async function checkWalletBalance() {
    try {
        const wallet = Keypair.fromSecretKey(bs58.decode(botState.settings.privateKey));
        const balance = await connection.getBalance(wallet.publicKey);
        const balanceSOL = balance / LAMPORTS_PER_SOL;

        console.log(`💰 Wallet Balance: ${balanceSOL} SOL`);

        if (balanceSOL < 0.00052) {
            console.error('❌ INSUFFICIENT BALANCE: Wallet has less than 0.01 SOL');
            return false;
        }

        return true;
    } catch (error) {
        console.error('❌ Error checking wallet balance:', error);
        return false;
    }
}

async function verifyTransactionOnChain(signature, maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`🔍 Transaction verification attempt ${attempt}/${maxRetries}...`);

            const status = await connection.getSignatureStatus(signature);

            if (status && status.value) {
                console.log(`✅ Transaction found on chain!`);
                return {
                    exists: true,
                    status: status.value,
                    confirmed: true
                };
            }

            // If not found, wait and retry
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

        } catch (error) {
            console.log(`Attempt ${attempt} failed:`, error.message);
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }

    console.log(`❌ Transaction not found on chain after ${maxRetries} attempts`);
    return {
        exists: false,
        status: null,
        confirmed: false
    };
}

async function monitorTransactionStatus(signature, tokenAddress) {
    console.log(`👀 Monitoring transaction: ${signature}`);

    let checks = 0;
    const maxChecks = 30; // Monitor for 60 seconds

    const checkInterval = setInterval(async () => {
        checks++;

        try {
            const status = await connection.getSignatureStatus(signature);

            if (status && status.value) {
                clearInterval(checkInterval);

                if (status.value.err) {
                    console.error(`❌ Transaction FAILED: ${signature}`, status.value.err);
                    broadcastToClients({
                        type: 'transaction_failed',
                        data: {
                            tokenAddress,
                            signature,
                            error: status.value.err,
                            timestamp: new Date().toISOString()
                        }
                    });
                } else {
                    console.log(`✅ Transaction CONFIRMED: ${signature}`);
                    broadcastToClients({
                        type: 'transaction_confirmed',
                        data: {
                            tokenAddress,
                            signature,
                            status: 'confirmed',
                            confirmationStatus: status.value.confirmationStatus,
                            timestamp: new Date().toISOString()
                        }
                    });
                }
                return;
            }

            // Still checking...
            if (checks >= maxChecks) {
                clearInterval(checkInterval);
                console.log(`⏱️ Stopped monitoring - transaction may still confirm later`);
                broadcastToClients({
                    type: 'transaction_timeout',
                    data: {
                        tokenAddress,
                        signature,
                        note: 'Transaction monitoring ended - check explorer for final status',
                        explorerUrl: `https://solscan.io/tx/${signature}`,
                        timestamp: new Date().toISOString()
                    }
                });
            }

        } catch (error) {
            console.log(`Check ${checks} error:`, error.message);
        }
    }, 2000); // Check every 2 seconds
}

async function confirmTransactionInBackground(signature, tokenAddress) {
    try {
        console.log(`\n⏳ Confirming transaction in background: ${signature}`);

        // Set a timeout for confirmation attempts
        const confirmationTimeout = setTimeout(() => {
            console.warn(`⚠️ Transaction confirmation timeout after 30 seconds`);
            console.warn(`This DOES NOT mean the transaction failed.`);
            console.warn(`The trade was already submitted and likely succeeded.`);
            console.warn(`Check signature in Solana Explorer: https://solscan.io/tx/${signature}`);

            // Broadcast timeout notification (but don't treat as failure)
            broadcastToClients({
                type: 'transaction_confirmation_pending',
                data: {
                    tokenAddress,
                    signature,
                    note: 'Transaction submitted successfully. Waiting for on-chain confirmation...',
                    explorerUrl: `https://solscan.io/tx/${signature}`,
                    timestamp: new Date().toISOString()
                }
            });
        }, 30000);

        try {
            const confirmation = await connection.confirmTransaction(signature, 'processed');
            clearTimeout(confirmationTimeout);

            if (confirmation.value.err) {
                console.error(`❌ Transaction failed on-chain: ${signature}`, confirmation.value.err);
                broadcastToClients({
                    type: 'transaction_failed',
                    data: {
                        tokenAddress,
                        signature,
                        error: confirmation.value.err,
                        timestamp: new Date().toISOString()
                    }
                });
            } else {
                console.log(`✅ Transaction confirmed on-chain: ${signature}`);
                broadcastToClients({
                    type: 'transaction_confirmed',
                    data: {
                        tokenAddress,
                        signature,
                        timestamp: new Date().toISOString()
                    }
                });
            }
        } catch (confirmError) {
            clearTimeout(confirmationTimeout);

            // Check if error is a timeout
            if (confirmError.message && confirmError.message.includes('expired')) {
                console.warn(`⚠️ Confirmation check timed out (transaction may still succeed)`);
                console.warn(`Signature: ${signature}`);
                console.warn(`Explorer: https://solscan.io/tx/${signature}`);

                // DON'T broadcast an error - the transaction was already sent
                // Just log for manual verification

            } else {
                console.error(`❌ Unexpected confirmation error:`, confirmError.message);
            }
        }
    } catch (error) {
        console.error(`❌ Background confirmation error:`, error.message);
        // Silently fail - transaction already executed
    }
}

// ========== COMPLETE getTokenPageUrl WITH DUAL BROWSER OPENING ==========
async function getTokenPageUrl(tokenAddress, destination, platform = null) {
    const urlStartTime = Date.now();
    console.log(`🌐 URL GENERATION START for ${tokenAddress} on ${destination}`);
    console.log(`📋 Platform parameter: ${platform}`);

    switch (destination) {
        case 'axiom':
            try {
                const checkStartTime = Date.now();
                const detectedToken = botState.detectedTokens.get(tokenAddress);

                const actualPlatform = platform || detectedToken?.platform;
                const actualPool = detectedToken?.pool || (platform === 'letsbonk' ? 'bonk' : 'pump');

                const isPumpToken = actualPlatform === 'pumpfun' && actualPool !== 'bonk';
                const isBonkToken = actualPlatform === 'letsbonk' || actualPool === 'bonk';

                console.log(`🔍 Token type detection:`, {
                    isPumpToken,
                    isBonkToken,
                    platform: actualPlatform,
                    pool: actualPool
                });

                // ✅ FOR BONK TOKENS: RETRY UNTIL PAIR ADDRESS FOUND
                if (isBonkToken) {
                    console.log(`🦎 Bonk token detected - will retry until pair address found...`);

                    const MAX_RETRIES = 10; // Maximum number of attempts
                    const RETRY_DELAY = 3000; // 3 seconds between retries
                    let attempt = 0;
                    let pairAddress = null;

                    while (attempt < MAX_RETRIES && !pairAddress) {
                        attempt++;
                        console.log(`\n${'='.repeat(80)}`);
                        console.log(`🔄 ATTEMPT ${attempt}/${MAX_RETRIES} - Fetching pair address from DexScreener...`);
                        console.log(`${'='.repeat(80)}`);

                        try {
                            const pairData = await getPairAddressFromDexScreener(tokenAddress);

                            if (pairData && pairData.pairAddress) {
                                pairAddress = pairData.pairAddress;
                                console.log(`✅ SUCCESS! DexScreener pair found: ${pairAddress}`);
                                console.log(`⏱️ Found after ${attempt} attempt(s)`);

                                console.log('\n' + '='.repeat(80));
                                console.log('🚀 BONK TOKEN - OPENING PAIR ADDRESS');
                                console.log('='.repeat(80));

                                const pairUrl = `https://axiom.trade/meme/${pairAddress}`;
                                console.log(`📊 Axiom URL (Pair Address): ${pairUrl}`);

                                // 🔥 BROADCAST PAIR ADDRESS
                                broadcastToClients({
                                    type: 'auto_open_token_page',
                                    data: {
                                        tokenAddress: tokenAddress,
                                        tokenPageUrl: pairUrl,
                                        destination: 'axiom',
                                        platform: 'letsbonk',
                                        addressType: 'pair_address',
                                        address: pairAddress,
                                        reason: 'bonk_token_pair_found',
                                        attempts: attempt,
                                        timestamp: new Date().toISOString()
                                    }
                                });

                                console.log('✅ Pair address broadcast sent to frontend');
                                console.log('='.repeat(80) + '\n');

                                return pairUrl;
                            } else {
                                console.log(`❌ Attempt ${attempt}: No pair found yet`);

                                if (attempt < MAX_RETRIES) {
                                    console.log(`⏳ Waiting ${RETRY_DELAY / 1000} seconds before retry...`);
                                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                                }
                            }
                        } catch (dexError) {
                            console.error(`❌ Attempt ${attempt} failed:`, dexError.message);

                            if (attempt < MAX_RETRIES) {
                                console.log(`⏳ Waiting ${RETRY_DELAY / 1000} seconds before retry...`);
                                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                            }
                        }
                    }

                    // ❌ ALL RETRIES EXHAUSTED
                    console.log('\n' + '='.repeat(80));
                    console.log(`❌ FAILED: Could not find pair address after ${MAX_RETRIES} attempts`);
                    console.log(`⏱️ Total time elapsed: ${Date.now() - urlStartTime}ms`);
                    console.log('='.repeat(80) + '\n');

                    // Broadcast failure notification to frontend
                    broadcastToClients({
                        type: 'pair_address_not_found',
                        data: {
                            tokenAddress: tokenAddress,
                            platform: 'letsbonk',
                            attempts: MAX_RETRIES,
                            message: 'Could not find pair address on DexScreener',
                            timestamp: new Date().toISOString()
                        }
                    });

                    // Return null or throw error - NO fallback URL
                    throw new Error(`Pair address not found after ${MAX_RETRIES} attempts`);
                }

                // ✅ FOR PUMP TOKENS: Use stored or calculated bonding curve
                if (isPumpToken) {
                    // Check stored bonding curve first
                    if (detectedToken && detectedToken.bondingCurveAddress) {
                        console.log(`✅ Using stored bonding curve: ${detectedToken.bondingCurveAddress}`);
                        return `https://axiom.trade/meme/${detectedToken.bondingCurveAddress}`;
                    }

                    // Calculate bonding curve
                    console.log(`🎯 Calculating bonding curve for Pump token...`);
                    try {
                        const { PublicKey } = require('@solana/web3.js');
                        const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
                        const mintPublicKey = new PublicKey(tokenAddress);

                        const [bondingCurve] = PublicKey.findProgramAddressSync(
                            [Buffer.from("bonding-curve"), mintPublicKey.toBytes()],
                            PUMP_FUN_PROGRAM
                        );

                        const bondingCurveAddress = bondingCurve.toString();
                        console.log(`✅ Calculated bonding curve: ${bondingCurveAddress}`);

                        // Store for future use
                        if (detectedToken) {
                            detectedToken.bondingCurveAddress = bondingCurveAddress;
                            botState.detectedTokens.set(tokenAddress, detectedToken);
                        }

                        return `https://axiom.trade/meme/${bondingCurveAddress}`;

                    } catch (error) {
                        console.error(`❌ Bonding curve calculation failed:`, error.message);
                    }
                }

                // ✅ ULTIMATE FALLBACK (for non-Bonk, non-Pump tokens)
                console.log(`⚠️ Using token address as fallback`);
                return `https://axiom.trade/meme/${tokenAddress}`;

            } catch (error) {
                console.error('❌ Error in getTokenPageUrl:', error);
                throw error; // Re-throw error instead of returning fallback
            }

        case 'neo_bullx':
        default:
            const totalUrlTime = Date.now() - urlStartTime;
            console.log(`⏱️ NEO BULLX URL GENERATION: ${totalUrlTime}ms`);
            return `https://neo.bullx.io/terminal?chainId=1399811149&address=${tokenAddress}`;
    }
}

// ========== TOKEN PROCESSING ==========
// ========== REVERT TO YOUR ORIGINAL WORKING CODE ==========
// Only fix the community detection logic, keep everything else EXACTLY the same

// KEEP YOUR ORIGINAL connectToPumpPortal() - DON'T CHANGE IT
// KEEP YOUR ORIGINAL connectToLetsBonk() - DON'T CHANGE IT  
// KEEP YOUR ORIGINAL start/stop endpoints - DON'T CHANGE THEM

async function performActualScraping(communityId, tokenData, tokenStartTime) {
    const logger = createBlueLogger();

    // ✅ DIRECTLY START WITH BROWSER SCRAPING (NO COMMUNITY ID CHECKING)
    logger.logBold('🔍 PHASE 1: Attempting to scrape community admin list...');
    logger.log(`🎯 Target Community: ${communityId}`);
    logger.log(`💰 Token: ${tokenData.tokenAddress || 'Unknown'}`);
    logger.log(`🏷️ Token Name: ${tokenData.name || 'Unknown'}`);

    // Initialize scraper if needed
    if (!twitterScraper.isInitialized) {
        logger.log('🤖 Twitter scraper not initialized, initializing...');
        const initSuccess = await twitterScraper.init();
        if (!initSuccess) {
            logger.error('Failed to initialize Twitter scraper');
            throw new Error('Failed to initialize Twitter scraper');
        }
        logger.success('Twitter scraper initialized successfully');
    }

    // Check session status
    logger.log('🔍 Checking Twitter login session status...');
    const sessionStatus = await twitterScraper.checkSessionStatus();

    if (!sessionStatus.loggedIn) {
        logger.error('Twitter session not active');
        throw new Error('Twitter session not active - admin needs to login manually');
    }

    logger.success('Twitter session active! Proceeding with community scraping...');

    // ✅ ACTUAL SCRAPING HAPPENS HERE
    logger.logBold(`🕷️ PHASE 2: Scraping community ${communityId} admin list...`);
    logger.log(`🌐 Target URL: https://x.com/i/communities/${communityId}/moderators`);

    const communityAdmins = await twitterScraper.scrapeCommunityAdmins(communityId);
    logger.log(`📊 Scraping completed! Found ${communityAdmins.length} admin(s)`);

    if (communityAdmins.length === 0) {
        logger.warning('No admins found in community (private/empty/restricted)');
        return null;
    }

    // ✅ PHASE 3: ADMIN MATCHING LOGIC
    logger.success(`SUCCESS! Found ${communityAdmins.length} admin(s) in community ${communityId}:`);
    communityAdmins.forEach((admin, index) => {
        logger.log(`   ${index + 1}. @${admin.username} (${admin.badgeType}) - Source: ${admin.source}`);
    });

    // Check if any community admin is in our lists
    for (const admin of communityAdmins) {
        logger.log(`🔍 Checking scraped admin: @${admin.username} (${admin.badgeType})`);

        // ✅ CORRECT: Check admin username in primary list
        const primaryAdminConfig = botState.checkAdminInPrimary(admin.username);
        if (primaryAdminConfig) {
            logger.success(`ADMIN MATCH FOUND! @${admin.username} found in PRIMARY admin list!`);

            return {
                matchType: 'primary_admin',
                matchedEntity: admin.username,
                detectionReason: `Primary Community Admin: @${admin.username} (${admin.badgeType}) from Community ${communityId}`,
                config: primaryAdminConfig,
                communityAdmins: communityAdmins,
                matchedAdmin: admin,
                scrapingMethod: 'community_admin_scraping'
            };
        }

        // ✅ CORRECT: Check admin username in secondary list
        const secondaryAdminConfig = botState.checkAdminInSecondary(admin.username);
        if (secondaryAdminConfig) {
            // ✅ ENHANCED TIMING LOG
            const matchTime = Date.now() - tokenStartTime;
            logSecondaryMatch(tokenData.tokenAddress, admin.username, matchTime);
            logAdminMatchTiming(tokenData.tokenAddress, admin.username, 'secondary_admin', matchTime); // ADD THIS LINE

            logger.success(`ADMIN MATCH FOUND! @${admin.username} found in SECONDARY admin list!`);

            return {
                matchType: 'secondary_admin',
                matchedEntity: admin.username,
                detectionReason: `Secondary Community Admin: @${admin.username} (${admin.badgeType}) from Community ${communityId}`,
                config: secondaryAdminConfig,
                communityAdmins: communityAdmins,
                matchedAdmin: admin,
                scrapingMethod: 'community_admin_scraping'
            };
        }

        // Check variations
        const usernameVariations = [
            admin.username,
            `@${admin.username}`,
            admin.username.toLowerCase(),
            `@${admin.username.toLowerCase()}`
        ];

        logger.log(`🔄 Checking variations for @${admin.username}: [${usernameVariations.join(', ')}]`);

        for (const variation of usernameVariations) {
            const primaryVariationConfig = botState.checkAdminInPrimary(variation);
            if (primaryVariationConfig) {
                logger.success(`VARIATION MATCH FOUND! @${admin.username} found in PRIMARY list as "${variation}"!`);

                return {
                    matchType: 'primary_admin',
                    matchedEntity: variation,
                    detectionReason: `Primary Community Admin: @${admin.username} (${admin.badgeType}) from Community ${communityId} (matched as ${variation})`,
                    config: primaryVariationConfig,
                    communityAdmins: communityAdmins,
                    matchedAdmin: admin,
                    scrapingMethod: 'community_admin_scraping_variation'
                };
            }

            const secondaryVariationConfig = botState.checkAdminInSecondary(variation);
            if (secondaryVariationConfig) {
                // ✅ LOG SECONDARY MATCH FOR VARIATIONS
                const matchTime = Date.now() - tokenStartTime;
                logSecondaryMatch(tokenData.tokenAddress, variation, matchTime);

                logger.success(`VARIATION MATCH FOUND! @${admin.username} found in SECONDARY list as "${variation}"!`);

                return {
                    matchType: 'secondary_admin',
                    matchedEntity: variation,
                    detectionReason: `Secondary Community Admin: @${admin.username} (${admin.badgeType}) from Community ${communityId} (matched as ${variation})`,
                    config: secondaryVariationConfig,
                    communityAdmins: communityAdmins,
                    matchedAdmin: admin,
                    scrapingMethod: 'community_admin_scraping_variation'
                };
            }
        }

        logger.warning(`No match found for @${admin.username} in any admin lists`);
    }

    logger.error('NO MATCHES FOUND! None of the scraped admins are in your admin lists');
    return null;
}

async function applyScrapingResultToToken(scrapingResult, communityId, tokenData, tokenStartTime) {
    const logger = createBlueLogger();

    if (!scrapingResult) {
        return null;
    }

    // ✅ CRITICAL FIX: Always log secondary matches with proper timing for each token
    if (scrapingResult.matchType === 'secondary_admin') {
        const matchTime = Date.now() - tokenStartTime;
        logSecondaryMatch(tokenData.tokenAddress, scrapingResult.matchedEntity, matchTime);
        logger.success(`🔔 Secondary match logged for this token: ${scrapingResult.matchedEntity} - ${matchTime}ms`);
    }

    // Broadcast the match found event for this specific token
    broadcastToClients({
        type: 'community_admin_match_found',
        data: {
            communityId: communityId,
            matchType: scrapingResult.matchType === 'primary_admin' ? 'primary' : 'secondary',
            matchedAdmin: scrapingResult.matchedAdmin || { username: scrapingResult.matchedEntity },
            matchedAs: scrapingResult.scrapingMethod,
            allScrapedAdmins: scrapingResult.communityAdmins || []
        }
    });

    return scrapingResult;
}

async function scrapeCommunityAndMatchAdmins(communityId, tokenData) {
    const tokenAddress = tokenData.tokenAddress;

    // ✅ START COMMUNITY SCRAPING TIMING
    timingTracker.checkpoint(tokenAddress, 'communityScrapingStart');
    const scrapingStartTime = Date.now();

    try {
        console.log(`🚀 API SCRAPING: Community ${communityId} (replacing browser scraping)`);

        // ✅ STEP 1: Use twitterapi.io API instead of browser scraping
        const moderators = await twitterAPI.getAllCommunityModerators(communityId);

        // ✅ END COMMUNITY SCRAPING TIMING
        timingTracker.checkpoint(tokenAddress, 'communityScrapingEnd');
        const scrapingDuration = Date.now() - scrapingStartTime;
        console.log(`⏱️ Community scraping completed in ${scrapingDuration}ms`);

        if (!moderators || moderators.length === 0) {
            console.log('❌ No moderators found in community');

            // Broadcast that no moderators were found
            broadcastToClients({
                type: 'community_scraping_info',
                data: {
                    communityId: communityId,
                    reason: 'No moderators found in community',
                    tokenAddress: tokenData.tokenAddress,
                    scrapingDuration: `${scrapingDuration}ms`,
                    timestamp: new Date().toISOString()
                }
            });

            return null;
        }

        // ✅ STEP 2: Transform API response to match your existing format
        const transformedAdmins = moderators.map(moderator => ({
            username: moderator.screen_name || moderator.name || 'unknown',
            displayName: moderator.name || moderator.screen_name || 'Unknown',
            userId: moderator.id,
            isVerified: moderator.verified || moderator.isBlueVerified,
            followersCount: moderator.followers_count,
            location: moderator.location,
            description: moderator.description,
            profileImageUrl: moderator.profile_image_url_https,
            badgeType: 'Admin',
            source: 'api_fetch'
        }));

        console.log(`✅ Successfully fetched ${transformedAdmins.length} moderators from community ${communityId}:`);
        transformedAdmins.forEach((admin, index) => {
            console.log(`   ${index + 1}. @${admin.username} (${admin.displayName}) - ${admin.followersCount || 0} followers`);
        });

        // ✅ START ADMIN MATCHING TIMING
        timingTracker.checkpoint(tokenAddress, 'adminMatchingStart');
        const matchingStartTime = Date.now();

        // ✅ STEP 3: Check against your admin lists using botState methods
        for (const admin of transformedAdmins) {
            console.log(`🔍 Checking scraped admin: @${admin.username}`);

            // Check against primary admin list
            const primaryAdminConfig = botState.checkAdminInPrimary(admin.username);
            if (primaryAdminConfig) {
                // ✅ END ADMIN MATCHING TIMING
                timingTracker.checkpoint(tokenAddress, 'adminMatchingEnd');
                const matchingDuration = Date.now() - matchingStartTime;
                console.log(`⏱️ Admin matching completed in ${matchingDuration}ms`);

                console.log(`✅ ADMIN MATCH FOUND! @${admin.username} found in PRIMARY admin list!`);

                // Record in timing metadata
                timingTracker.recordMetadata(tokenAddress, {
                    communityId: communityId,
                    matchedAdmin: admin.username,
                    matchType: 'primary',
                    scrapingDuration: `${scrapingDuration}ms`,
                    matchingDuration: `${matchingDuration}ms`,
                    totalCommunityProcessing: `${Date.now() - scrapingStartTime}ms`
                });

                return {
                    matchType: 'primary_admin',
                    matchedEntity: admin.username,
                    detectionReason: `Primary Community Admin: @${admin.username} from Community ${communityId}`,
                    config: primaryAdminConfig,
                    matchedAdmin: admin,
                    scrapingMethod: 'api_fetch',
                    scrapingDuration,
                    matchingDuration
                };
            }

            // Check against secondary admin list
            const secondaryAdminConfig = botState.checkAdminInSecondary(admin.username);
            if (secondaryAdminConfig) {
                // ✅ END ADMIN MATCHING TIMING
                timingTracker.checkpoint(tokenAddress, 'adminMatchingEnd');
                const matchingDuration = Date.now() - matchingStartTime;
                console.log(`⏱️ Admin matching completed in ${matchingDuration}ms`);

                console.log(`✅ ADMIN MATCH FOUND! @${admin.username} found in SECONDARY admin list!`);

                // Record in timing metadata
                timingTracker.recordMetadata(tokenAddress, {
                    communityId: communityId,
                    matchedAdmin: admin.username,
                    matchType: 'secondary',
                    scrapingDuration: `${scrapingDuration}ms`,
                    matchingDuration: `${matchingDuration}ms`,
                    totalCommunityProcessing: `${Date.now() - scrapingStartTime}ms`
                });

                return {
                    matchType: 'secondary_admin',
                    matchedEntity: admin.username,
                    detectionReason: `Secondary Community Admin: @${admin.username} from Community ${communityId}`,
                    config: secondaryAdminConfig,
                    matchedAdmin: admin,
                    scrapingMethod: 'api_fetch',
                    scrapingDuration,
                    matchingDuration
                };
            }

            // Check username variations
            const usernameVariations = [
                admin.username,
                admin.username.toLowerCase()
            ];

            console.log(`🔄 Checking variations for ${admin.username}: [${usernameVariations.join(', ')}]`);

            for (const variation of usernameVariations) {
                const primaryVariationConfig = botState.checkAdminInPrimary(variation);
                if (primaryVariationConfig) {
                    // ✅ END ADMIN MATCHING TIMING
                    timingTracker.checkpoint(tokenAddress, 'adminMatchingEnd');
                    const matchingDuration = Date.now() - matchingStartTime;
                    console.log(`⏱️ Admin matching completed in ${matchingDuration}ms`);

                    console.log(`✅ VARIATION MATCH FOUND! "${variation}" found in PRIMARY admin list!`);

                    // Record in timing metadata
                    timingTracker.recordMetadata(tokenAddress, {
                        communityId: communityId,
                        matchedAdmin: variation,
                        originalUsername: admin.username,
                        matchType: 'primary_variation',
                        scrapingDuration: `${scrapingDuration}ms`,
                        matchingDuration: `${matchingDuration}ms`,
                        totalCommunityProcessing: `${Date.now() - scrapingStartTime}ms`
                    });

                    return {
                        matchType: 'primary_admin',
                        matchedEntity: variation,
                        detectionReason: `Primary Community Admin: @${admin.username} (variation: ${variation}) from Community ${communityId}`,
                        config: primaryVariationConfig,
                        matchedAdmin: admin,
                        scrapingMethod: 'api_fetch',
                        scrapingDuration,
                        matchingDuration
                    };
                }

                const secondaryVariationConfig = botState.checkAdminInSecondary(variation);
                if (secondaryVariationConfig) {
                    // ✅ END ADMIN MATCHING TIMING
                    timingTracker.checkpoint(tokenAddress, 'adminMatchingEnd');
                    const matchingDuration = Date.now() - matchingStartTime;
                    console.log(`⏱️ Admin matching completed in ${matchingDuration}ms`);

                    console.log(`✅ VARIATION MATCH FOUND! "${variation}" found in SECONDARY admin list!`);

                    // Record in timing metadata
                    timingTracker.recordMetadata(tokenAddress, {
                        communityId: communityId,
                        matchedAdmin: variation,
                        originalUsername: admin.username,
                        matchType: 'secondary_variation',
                        scrapingDuration: `${scrapingDuration}ms`,
                        matchingDuration: `${matchingDuration}ms`,
                        totalCommunityProcessing: `${Date.now() - scrapingStartTime}ms`
                    });

                    return {
                        matchType: 'secondary_admin',
                        matchedEntity: variation,
                        detectionReason: `Secondary Community Admin: @${admin.username} (variation: ${variation}) from Community ${communityId}`,
                        config: secondaryVariationConfig,
                        matchedAdmin: admin,
                        scrapingMethod: 'api_fetch',
                        scrapingDuration,
                        matchingDuration
                    };
                }
            }
        }

        // ✅ END ADMIN MATCHING TIMING (NO MATCH FOUND)
        timingTracker.checkpoint(tokenAddress, 'adminMatchingEnd');
        const matchingDuration = Date.now() - matchingStartTime;
        console.log(`⏱️ Admin matching completed in ${matchingDuration}ms (no matches)`);

        console.log('❌ No matching admins found in configured lists');

        // Record in timing metadata
        timingTracker.recordMetadata(tokenAddress, {
            communityId: communityId,
            matchedAdmin: 'none',
            matchType: 'no_match',
            scrapingDuration: `${scrapingDuration}ms`,
            matchingDuration: `${matchingDuration}ms`,
            totalCommunityProcessing: `${Date.now() - scrapingStartTime}ms`,
            totalAdminsChecked: transformedAdmins.length
        });

        // Broadcast that no matches were found
        broadcastToClients({
            type: 'community_scraping_info',
            data: {
                communityId: communityId,
                reason: `${transformedAdmins.length} admins scraped, but none match your lists`,
                scrapedAdmins: transformedAdmins,
                tokenAddress: tokenData.tokenAddress,
                scrapingDuration: `${scrapingDuration}ms`,
                matchingDuration: `${matchingDuration}ms`,
                timestamp: new Date().toISOString()
            }
        });

        return null;

    } catch (error) {
        // ✅ END COMMUNITY SCRAPING TIMING (ERROR)
        timingTracker.checkpoint(tokenAddress, 'communityScrapingEnd');
        const scrapingDuration = Date.now() - scrapingStartTime;

        console.error('❌ Error in API-based community scraping:', error);

        // ✅ NEW: Check for specific API errors and broadcast to frontend
        let errorType = 'general_error';
        let userMessage = 'Unknown Twitter API error occurred';

        if (error.message.includes('402 Payment Required') || error.message.includes('Credits is not enough')) {
            errorType = 'credits_exhausted';
            userMessage = 'Twitter API credits are exhausted. Please recharge your account.';
            console.log('💳 Twitter API credits exhausted - broadcasting to frontend');
        } else if (error.message.includes('401') || error.message.includes('Unauthorized')) {
            errorType = 'unauthorized';
            userMessage = 'Twitter API access denied. Check your API key configuration.';
        } else if (error.message.includes('403')) {
            errorType = 'forbidden';
            userMessage = 'Twitter API access forbidden. Your account may be restricted.';
        } else if (error.message.includes('429')) {
            errorType = 'rate_limited';
            userMessage = 'Twitter API rate limit exceeded. Please wait before trying again.';
        } else if (error.message.includes('timeout') || error.message.includes('TIMEOUT')) {
            errorType = 'timeout';
            userMessage = 'Twitter API request timed out. Please try again.';
        }

        // Record error in timing metadata
        timingTracker.recordMetadata(tokenAddress, {
            communityId: communityId,
            scrapingError: error.message,
            errorType: errorType,
            scrapingDuration: `${scrapingDuration}ms`,
            scrapingFailed: true
        });

        // Broadcast the error to frontend
        broadcastToClients({
            type: 'twitter_api_error',
            data: {
                communityId: communityId,
                error: userMessage,
                errorType: errorType,
                message: userMessage,
                tokenAddress: tokenData.tokenAddress,
                originalError: error.message,
                scrapingDuration: `${scrapingDuration}ms`,
                timestamp: new Date().toISOString()
            }
        });

        throw error; // Re-throw so calling code can handle it
    }
}

// ========== ULTRA-FAST SNIPE ALL MODE (NO CHECKS) ==========
async function processTokenInstantSnipe(tokenData, platform) {
    const tokenAddress = tokenData.mint;
    const masterStartTime = tokenData.masterStartTime || Date.now();
    const processingStartTime = Date.now();

    console.log(`⚡⚡⚡ SNIPE ALL MODE: ${tokenAddress}`);
    console.log(`⏱️ Time from detection: ${Date.now() - masterStartTime}ms`);

    const instantTokenData = {
        tokenAddress,
        platform,
        creatorWallet: tokenData.creator || tokenData.traderPublicKey,
        name: tokenData.name || 'Instant Snipe',
        symbol: tokenData.symbol || 'TOKEN',
        uri: tokenData.uri,
        bondingCurveAddress: tokenData.bondingCurveAddress || tokenData.bondingCurveKey,
        masterStartTime,
        processingTime: Date.now() - processingStartTime,
        detectionToProcessing: processingStartTime - masterStartTime,
        matchType: 'snipe_all',
        matchedEntity: 'All tokens',
        detectionReason: 'Snipe All Mode Enabled',
        config: botState.settings.globalSnipeSettings
    };

    botState.addDetectedToken(tokenAddress, instantTokenData);

    logTokenProcessingDecision(tokenAddress, 'detected', 'Snipe all mode', {
        platform,
        name: tokenData.name || 'Unknown'
    });

    broadcastToClients({
        type: 'token_detected',
        data: instantTokenData
    });

    if (!botState.settings.detectionOnlyMode) {
        console.log('⚡ INSTANT SNIPE EXECUTING (SNIPE ALL MODE)...');
        await snipeToken(tokenAddress, botState.settings.globalSnipeSettings);
    }

    const totalTime = Date.now() - masterStartTime;
    console.log(`⚡⚡⚡ SNIPE ALL COMPLETED: ${totalTime}ms total\n`);
}

function debugMatchingProcess(tokenAddress, step, data) {
    const timestamp = new Date().toISOString();
    const debugEntry = {
        timestamp,
        tokenAddress: tokenAddress.substring(0, 16) + '...',
        step,
        ...data
    };

    console.log(`🔍 [DEBUG MATCHING] ${step}:`, JSON.stringify(debugEntry, null, 2));

    // Also write to a dedicated debug file
    try {
        const debugLogFile = path.join(__dirname, 'matching_debug.log');
        fs.appendFileSync(debugLogFile, JSON.stringify(debugEntry) + '\n');
    } catch (error) {
        // Silently fail if file write fails
    }
}

async function processNewToken(tokenData, platform) {
    const tokenAddress = tokenData.mint;
    const creatorWallet = tokenData.creator || tokenData.traderPublicKey;
    const masterStartTime = tokenData.masterStartTime || Date.now();

    // ✅ DEBUG: Token processing begins
    debugMatchingProcess(tokenAddress, 'TOKEN_PROCESSING_START', {
        platform,
        creatorWallet: creatorWallet ? creatorWallet.substring(0, 16) + '...' : 'None',
        name: tokenData.name || 'Unknown',
        symbol: tokenData.symbol || 'Unknown',
        masterStartTime: new Date(masterStartTime).toISOString()
    });

    // ✅ FIX 1: Set platform in tokenData if not already set
    if (platform && !tokenData.platform) {
        tokenData.platform = platform;
    }

    // ✅ FIX 2: Normalize platform and use a single variable throughout
    let normalizedPlatform = tokenData.platform || platform || 'unknown';
    normalizedPlatform = normalizedPlatform.replace(/\./g, '').toLowerCase();  // Remove ALL dots, lowercase

    // ✅ FIX 3: Update tokenData with normalized version
    tokenData.platform = normalizedPlatform;

    console.log(`🔍 Platform normalization: "${platform || tokenData.platform}" → "${normalizedPlatform}"`);

    // ✅ START TIMING TRACKING
    timingTracker.startToken(tokenAddress);
    timingTracker.checkpoint(tokenAddress, 'processingStart');
    timingTracker.recordMetadata(tokenAddress, {
        platform: normalizedPlatform,  // ✅ Use normalized version
        name: tokenData.name || 'Unknown',
        symbol: tokenData.symbol || 'Unknown',
        pool: tokenData.pool,
        creatorWallet: creatorWallet ? creatorWallet.substring(0, 16) : 'None'
    });

    const redLogger = createRedLogger();

    console.log(`\n${'='.repeat(80)}`);
    console.log(`TOKEN PROCESSING START: ${tokenAddress}`);
    console.log(`Platform: ${normalizedPlatform} | Time from detection: ${Date.now() - masterStartTime}ms`);  // ✅ Use normalized
    console.log(`${'='.repeat(80)}`);

    let sniped = false;
    let matchDetails = {};

    // ========== PARALLEL PROCESSING: WALLET CHECK + METADATA FETCH ==========

    // Promise 1: INSTANT WALLET CHECK
    const walletCheckPromise = (async () => {
        timingTracker.checkpoint(tokenAddress, 'walletCheckStart');

        if (!botState.settings.enableAdminFilter || !creatorWallet) {
            timingTracker.checkpoint(tokenAddress, 'walletCheckEnd');

            // ✅ DEBUG: Wallet check skipped
            debugMatchingProcess(tokenAddress, 'WALLET_CHECK_SKIPPED', {
                reason: !creatorWallet ? 'No creator wallet' : 'Admin filter disabled',
                enableAdminFilter: botState.settings.enableAdminFilter,
                hasCreatorWallet: !!creatorWallet
            });

            return { match: false };
        }

        // ✅ DEBUG: Starting wallet check
        debugMatchingProcess(tokenAddress, 'WALLET_CHECK_START', {
            creatorWallet: creatorWallet.substring(0, 16) + '...',
            primaryDetectionEnabled: botState.settings.enablePrimaryDetection,
            secondaryDetectionEnabled: botState.settings.enableSecondaryDetection
        });

        console.log(`⚡ PARALLEL: Wallet check for ${creatorWallet.substring(0, 8)}...`);

        // Check PRIMARY first
        const primaryMatch = botState.checkAdminInPrimary(creatorWallet);

        // ✅ DEBUG: Primary wallet check result
        debugMatchingProcess(tokenAddress, 'PRIMARY_WALLET_CHECK_RESULT', {
            wallet: creatorWallet.substring(0, 16) + '...',
            matchFound: !!primaryMatch,
            matchDetails: primaryMatch ? {
                id: primaryMatch.id,
                amount: primaryMatch.amount,
                fees: primaryMatch.fees,
                priorityFee: primaryMatch.priorityFee
            } : null
        });

        timingTracker.checkpoint(tokenAddress, 'walletCheckEnd');

        if (primaryMatch) {
            const matchTime = Date.now() - masterStartTime;

            // ✅ DEBUG: Primary wallet match found
            debugMatchingProcess(tokenAddress, 'PRIMARY_WALLET_MATCH_FOUND', {
                wallet: creatorWallet.substring(0, 16) + '...',
                matchTime: `${matchTime}ms`,
                config: {
                    amount: primaryMatch.amount,
                    fees: primaryMatch.fees,
                    priorityFee: primaryMatch.priorityFee
                }
            });

            console.log(`⚡⚡⚡ INSTANT PRIMARY WALLET MATCH! (${matchTime}ms)`);

            redLogger.separator();
            redLogger.matchFound(
                `${creatorWallet.substring(0, 8)}...`,
                'PRIMARY WALLET (INSTANT)',
                {
                    name: tokenData.name || 'Unknown',
                    symbol: tokenData.symbol || 'Unknown',
                    address: tokenAddress,
                    platform: platform
                }
            );
            redLogger.info(`⚡ Wallet checked in ${matchTime}ms`);
            redLogger.separator();

            logPrimaryMatch(
                tokenAddress,
                creatorWallet.substring(0, 16),
                'wallet_address_instant',
                matchTime,
                'instant_wallet_check'
            );

            matchDetails = {
                matchType: 'Primary Wallet',
                matchedEntity: creatorWallet.substring(0, 16),
                detectionMethod: 'Instant Wallet Check',
                matchTime: `${matchTime}ms`
            };

            return {
                match: true,
                type: 'primary',
                matchType: 'primary_admin',
                matchedEntity: creatorWallet,
                detectionReason: `Primary Wallet: ${creatorWallet.substring(0, 8)}...`,
                config: primaryMatch,
                matchTime
            };
        }

        // Only check SECONDARY if PRIMARY didn't match
        if (botState.settings.enableSecondaryDetection) {
            const secondaryMatch = botState.checkAdminInSecondary(creatorWallet);

            // ✅ DEBUG: Secondary wallet check result
            debugMatchingProcess(tokenAddress, 'SECONDARY_WALLET_CHECK_RESULT', {
                wallet: creatorWallet.substring(0, 16) + '...',
                matchFound: !!secondaryMatch,
                matchDetails: secondaryMatch ? {
                    id: secondaryMatch.id,
                    amount: secondaryMatch.amount,
                    fees: secondaryMatch.fees,
                    priorityFee: secondaryMatch.priorityFee
                } : null
            });

            if (secondaryMatch) {
                const matchTime = Date.now() - masterStartTime;

                // ✅ DEBUG: Secondary wallet match found
                debugMatchingProcess(tokenAddress, 'SECONDARY_WALLET_MATCH_FOUND', {
                    wallet: creatorWallet.substring(0, 16) + '...',
                    matchTime: `${matchTime}ms`,
                    config: {
                        amount: secondaryMatch.amount,
                        fees: secondaryMatch.fees,
                        priorityFee: secondaryMatch.priorityFee
                    }
                });

                logSecondaryMatch(tokenAddress, creatorWallet, matchTime);

                console.log(`⚡ INSTANT SECONDARY WALLET MATCH! (${matchTime}ms)`);

                matchDetails = {
                    matchType: 'Secondary Wallet',
                    matchedEntity: creatorWallet.substring(0, 16),
                    detectionMethod: 'Instant Wallet Check',
                    matchTime: `${matchTime}ms`
                };

                return {
                    match: true,
                    type: 'secondary',
                    matchType: 'secondary_admin',
                    matchedEntity: creatorWallet,
                    detectionReason: `Secondary Wallet: ${creatorWallet.substring(0, 8)}...`,
                    config: secondaryMatch,
                    matchTime
                };
            }
        }

        // ✅ DEBUG: No wallet matches found
        debugMatchingProcess(tokenAddress, 'NO_WALLET_MATCHES', {
            wallet: creatorWallet.substring(0, 16) + '...',
            primaryChecked: true,
            secondaryChecked: botState.settings.enableSecondaryDetection,
            totalWalletChecks: 1 + (botState.settings.enableSecondaryDetection ? 1 : 0)
        });

        console.log(`⏳ No wallet match - continuing to metadata check`);
        return { match: false };
    })();

    // Promise 2: METADATA FETCH (runs in parallel with wallet check)
    const metadataPromise = (async () => {
        timingTracker.checkpoint(tokenAddress, 'metadataStart');

        // ✅ DEBUG: Starting metadata fetch
        debugMatchingProcess(tokenAddress, 'METADATA_FETCH_START', {
            hasPreFetchedMetadata: !!(tokenData.metadataAlreadyFetched && tokenData.twitter),
            metadataAlreadyFetched: tokenData.metadataAlreadyFetched,
            hasTwitter: !!tokenData.twitter
        });

        // ✅ CHECK IF METADATA ALREADY FETCHED BY BLOCKCHAIN LISTENER
        if (tokenData.metadataAlreadyFetched && tokenData.twitter) {
            console.log(`⚡ SKIPPING metadata fetch - already extracted in blockchain listener`);
            console.log(`✅ Using pre-fetched metadata (0ms - instant)`);

            // Use pre-extracted data from blockchain listener
            const enhancedData = {
                name: tokenData.name || 'Unknown',
                symbol: tokenData.symbol || 'UNKNOWN',
                description: tokenData.description || 'A new token on Solana',
                imageUrl: tokenData.image || null,
                twitterUrl: tokenData.twitter || null,
                website: tokenData.website || null,
                hasEnhancedData: true,
                source: 'blockchain_listener' // Mark source for debugging
            };

            // Use pre-extracted Twitter data
            const twitterData = {
                type: tokenData.twitterType || null,
                id: tokenData.twitterCommunityId || null,
                handle: tokenData.twitterHandle || null,
                admin: tokenData.twitterAdmin || null,
                originalUrl: tokenData.twitter || null,
                source: 'blockchain_listener' // Mark source for debugging
            };

            timingTracker.checkpoint(tokenAddress, 'metadataEnd');
            timingTracker.checkpoint(tokenAddress, 'twitterExtractionStart');
            timingTracker.checkpoint(tokenAddress, 'twitterExtractionEnd');

            console.log(`📊 Pre-fetched metadata summary:`);
            console.log(`   Name: ${enhancedData.name}`);
            console.log(`   Symbol: ${enhancedData.symbol}`);
            console.log(`   Has Twitter: ${!!twitterData.type}`);
            console.log(`   Twitter Type: ${twitterData.type || 'none'}`);
            console.log(`   Twitter Handle: ${twitterData.handle || 'none'}`);
            console.log(`   Twitter Community: ${twitterData.id || 'none'}`);

            // ✅ DEBUG: Pre-fetched metadata used
            debugMatchingProcess(tokenAddress, 'PRE_FETCHED_METADATA_USED', {
                name: enhancedData.name,
                symbol: enhancedData.symbol,
                twitterType: twitterData.type,
                twitterHandle: twitterData.handle,
                twitterCommunityId: twitterData.id
            });

            return { enhancedData, twitterData };
        }

        // ✅ FALLBACK: Only fetch if metadata wasn't pre-fetched
        console.log(`⏳ PARALLEL: Metadata fetch started (fallback - blockchain listener didn't provide complete data)...`);
        const metadataStartTime = Date.now();

        const isBonkToken = platform === 'letsbonk' || tokenData.pool === 'bonk';
        const isDemoToken = tokenData.metadata && (tokenData.metadata.twitter || tokenData.metadata.name);

        let enhancedData = null;
        let twitterData = { type: null, id: null, handle: null, admin: null };

        // ✅ Fetch metadata using improved function
        try {
            enhancedData = await fetchTokenMetadata(tokenData);

            if (enhancedData.twitterHandle) {
                const twitterInfo = extractTwitterDataRobust(enhancedData.twitterHandle, 'token_metadata');
                twitterData = {
                    type: twitterInfo.type,
                    id: twitterInfo.id,
                    handle: twitterInfo.handle,
                    admin: twitterInfo.handle || twitterInfo.id,
                    originalUrl: enhancedData.twitterHandle,
                    source: 'token_metadata_fallback'
                };
            }
        } catch (error) {
            console.log(`⚠️ Metadata fetch failed: ${error.message}, using fallback`);
            enhancedData = {
                name: tokenData.name || `Token ${tokenAddress.slice(0, 8)}`,
                symbol: tokenData.symbol || 'TOKEN',
                description: null,
                imageUrl: tokenData.uri || null,
                twitterUrl: null,
                website: null,
                hasEnhancedData: false,
                source: 'fallback'
            };
        }

        timingTracker.checkpoint(tokenAddress, 'metadataEnd');
        const metadataTime = Date.now() - metadataStartTime;
        console.log(`✅ PARALLEL: Metadata fetch completed (${metadataTime}ms)`);

        timingTracker.checkpoint(tokenAddress, 'twitterExtractionStart');
        timingTracker.checkpoint(tokenAddress, 'twitterExtractionEnd');

        // ✅ DEBUG: Metadata fetch completed
        debugMatchingProcess(tokenAddress, 'METADATA_FETCH_COMPLETED', {
            metadataTime: `${metadataTime}ms`,
            name: enhancedData.name,
            symbol: enhancedData.symbol,
            hasTwitter: !!twitterData.type,
            twitterType: twitterData.type,
            twitterHandle: twitterData.handle,
            twitterCommunityId: twitterData.id,
            source: enhancedData.source
        });

        return { enhancedData, twitterData };
    })();

    // ========== WAIT FOR WALLET CHECK FIRST ==========
    try {
        const walletResult = await walletCheckPromise;

        if (walletResult.match && !sniped) {
            sniped = true;

            const quickTokenData = {
                tokenAddress,
                platform,
                creatorWallet,
                name: tokenData.name || 'Quick Snipe',
                symbol: tokenData.symbol || 'TOKEN',
                uri: tokenData.uri,
                bondingCurveAddress: tokenData.bondingCurveAddress || tokenData.bondingCurveKey,
                masterStartTime,
                processingTime: walletResult.matchTime,
                detectionToProcessing: Date.now() - masterStartTime,
                matchType: walletResult.matchType,
                matchedEntity: walletResult.matchedEntity,
                detectionReason: walletResult.detectionReason,
                config: walletResult.config
            };

            botState.addDetectedToken(tokenAddress, quickTokenData);

            broadcastToClients({
                type: 'token_detected',
                data: {
                    ...quickTokenData,
                    twitterData: {
                        type: quickTokenData.twitterType || null,
                        handle: quickTokenData.twitterHandle || null,
                        id: quickTokenData.twitterCommunityId || null,
                        admin: quickTokenData.twitterAdmin || null,
                        url: quickTokenData.twitter || null
                    }
                }
            });

            // ✅ DEBUG: Wallet match processing complete
            debugMatchingProcess(tokenAddress, 'WALLET_MATCH_PROCESSING_COMPLETE', {
                matchType: walletResult.type,
                matchedEntity: walletResult.matchedEntity,
                sniped: walletResult.type === 'primary' && !botState.settings.detectionOnlyMode,
                detectionOnlyMode: botState.settings.detectionOnlyMode
            });

            if (walletResult.type === 'primary' && !botState.settings.detectionOnlyMode) {
                console.log('\n⚡⚡⚡ INSTANT SNIPE EXECUTING...');

                timingTracker.checkpoint(tokenAddress, 'snipeStart');
                await snipeToken(tokenAddress, walletResult.config);
                timingTracker.checkpoint(tokenAddress, 'snipeEnd');

                console.log(`⚡ TOTAL TIME (WALLET MATCH): ${Date.now() - masterStartTime}ms`);
                console.log(`${YELLOW}🔚 Thread ending: Primary wallet match sniped${RESET}`);

                // ✅ FINISH TIMING TRACKING - SNIPED
                timingTracker.finishToken(tokenAddress, 'sniped', matchDetails);

                // ✅ DEBUG: Primary wallet snipe completed
                debugMatchingProcess(tokenAddress, 'PRIMARY_WALLET_SNIPE_COMPLETED', {
                    totalTime: `${Date.now() - masterStartTime}ms`,
                    config: walletResult.config
                });

                return; // ✅ OUTCOME 2: Thread ends here
            } else if (walletResult.type === 'secondary') {
                broadcastToClients({
                    type: 'secondary_popup_trigger',
                    data: {
                        tokenData: quickTokenData,
                        globalSnipeSettings: botState.settings.globalSnipeSettings,
                        timestamp: new Date().toISOString()
                    }
                });

                // ✅ DEBUG: Secondary wallet match broadcast
                debugMatchingProcess(tokenAddress, 'SECONDARY_WALLET_MATCH_BROADCAST', {
                    totalTime: `${Date.now() - masterStartTime}ms`,
                    config: walletResult.config
                });

                console.log(`${YELLOW}🔚 Thread ending: Secondary wallet match broadcast${RESET}`);

                // ✅ FINISH TIMING TRACKING - DETECTED ONLY (SECONDARY)
                timingTracker.finishToken(tokenAddress, 'detected_only', matchDetails);

                return; // ✅ OUTCOME 3: Thread ends here
            }
        }

        // ========== NO WALLET MATCH - WAIT FOR METADATA ==========
        console.log(`⏳ No wallet match - waiting for metadata to complete...`);
        const { enhancedData, twitterData } = await metadataPromise;

        console.log(`\nTOKEN DATA SUMMARY`);
        console.log(`  Name: ${enhancedData.name}`);
        console.log(`  Symbol: ${enhancedData.symbol}`);
        console.log(`  Creator Wallet: ${creatorWallet || 'Unknown'}`);
        console.log(`  Has Twitter: ${!!twitterData.type}`);
        console.log(`  Has Wallet: ${!!creatorWallet}`);

        // Record metadata in timing tracker
        timingTracker.recordMetadata(tokenAddress, {
            tokenName: enhancedData.name,
            tokenSymbol: enhancedData.symbol,
            hasTwitterData: !!twitterData.type,
            twitterType: twitterData.type || 'none',
            twitterHandle: twitterData.handle || 'none',
            twitterCommunityId: twitterData.id || 'none'
        });

        // ✅ DEBUG: Metadata processing complete
        debugMatchingProcess(tokenAddress, 'METADATA_PROCESSING_COMPLETE', {
            hasTwitterData: !!twitterData.type,
            twitterType: twitterData.type,
            twitterHandle: twitterData.handle,
            twitterCommunityId: twitterData.id,
            name: enhancedData.name,
            symbol: enhancedData.symbol
        });

        // ========== TWEET/STATUS REUSE CHECK ==========
        console.log(`\nTWEET REUSE CHECK PHASE`);

        if (twitterData.type === 'tweet' && twitterData.id) {
            console.log(`Tweet detected: ID ${twitterData.id} from @${twitterData.handle}`);

            if (botState.settings.enableCommunityReuse) {
                const tweetUsed = await isTweetUsedInFirebase(twitterData.id);
                if (tweetUsed) {
                    console.log(`REJECTED: Tweet ${twitterData.id} already used`);
                    console.log(`${YELLOW}🔚 Thread ending: Tweet already used (filtered)${RESET}`);

                    // ✅ DEBUG: Tweet already used
                    debugMatchingProcess(tokenAddress, 'TWEET_ALREADY_USED', {
                        tweetId: twitterData.id,
                        twitterHandle: twitterData.handle,
                        reason: 'Tweet reuse prevention'
                    });

                    logTokenProcessingDecision(tokenAddress, 'rejected', 'Tweet already used', {
                        tweetId: twitterData.id,
                        handle: twitterData.handle,
                        creatorWallet
                    });

                    // ✅ FINISH TIMING TRACKING - FILTERED (TWEET REUSE)
                    timingTracker.finishToken(tokenAddress, 'filtered', {
                        filterReason: 'Tweet already used',
                        tweetId: twitterData.id
                    });

                    return; // ✅ OUTCOME 1: Thread ends here
                }
                console.log(`Tweet ${twitterData.id} is NEW - continuing processing`);
            } else {
                console.log(`Tweet reuse prevention DISABLED - skipping check`);
            }

            const saveSuccess = await markTweetAsUsedInFirebase(twitterData.id, twitterData.handle, {
                tokenAddress,
                name: enhancedData.name,
                platform
            });
            if (saveSuccess) {
                console.log(`Tweet ${twitterData.id} marked as used in cache and Firebase`);
            }
        }

        // ========== CREATE COMPLETE TOKEN DATA ==========
        const completeTokenData = {
            tokenAddress,
            platform,
            creatorWallet,
            name: enhancedData.name,
            symbol: enhancedData.symbol,
            description: enhancedData.description,
            uri: enhancedData.imageUrl,
            imageUrl: enhancedData.imageUrl,
            logoURI: enhancedData.imageUrl,
            marketCapSol: tokenData.marketCapSol || 0,
            solAmount: tokenData.solAmount || 0,
            pool: tokenData.pool,
            twitter: enhancedData.twitterUrl,
            twitterType: twitterData.type,
            twitterCommunityId: twitterData.id,
            twitterHandle: twitterData.handle,
            twitterAdmin: twitterData.admin,
            website: enhancedData.website,
            hasTokenMetadataData: enhancedData.hasEnhancedData,
            isBonkToken: platform === 'letsbonk' || tokenData.pool === 'bonk',
            bondingCurveAddress: tokenData.bondingCurveAddress || tokenData.bondingCurveKey || null,
            masterStartTime: masterStartTime,
            processingTime: Date.now() - masterStartTime,
            detectionToProcessing: Date.now() - masterStartTime
        };

        // ========== FILTERING LOGIC ==========
        console.log(`\nFILTERING PHASE`);
        console.log(`  Snipe All Tokens: ${botState.settings.snipeAllTokens}`);
        console.log(`  Admin Filter Enabled: ${botState.settings.enableAdminFilter}`);
        console.log(`  Detection Only Mode: ${botState.settings.detectionOnlyMode}`);

        // Check snipe all tokens mode
        if (botState.settings.snipeAllTokens) {
            console.log(`SNIPE ALL MODE: Token automatically detected`);

            // ✅ DEBUG: Snipe all mode activated
            debugMatchingProcess(tokenAddress, 'SNIPE_ALL_MODE_ACTIVATED', {
                name: completeTokenData.name,
                symbol: completeTokenData.symbol,
                detectionOnlyMode: botState.settings.detectionOnlyMode
            });

            const detectedTokenData = {
                ...completeTokenData,
                matchType: 'snipe_all',
                matchedEntity: 'All tokens',
                detectionReason: 'Snipe All Mode Enabled',
                config: botState.settings.globalSnipeSettings
            };

            botState.addDetectedToken(tokenAddress, detectedTokenData);

            logTokenProcessingDecision(tokenAddress, 'detected', 'Snipe all mode', {
                platform,
                name: completeTokenData.name
            });

            broadcastToClients({
                type: 'token_detected',
                data: detectedTokenData
            });

            if (!botState.settings.detectionOnlyMode) {
                timingTracker.checkpoint(tokenAddress, 'snipeStart');
                await snipeToken(tokenAddress, botState.settings.globalSnipeSettings);
                timingTracker.checkpoint(tokenAddress, 'snipeEnd');

                console.log(`${YELLOW}🔚 Thread ending: Snipe all mode executed${RESET}`);

                matchDetails = {
                    matchType: 'Snipe All Mode',
                    matchedEntity: 'All tokens',
                    detectionMethod: 'Automatic detection'
                };

                // ✅ FINISH TIMING TRACKING - SNIPED (SNIPE ALL)
                timingTracker.finishToken(tokenAddress, 'sniped', matchDetails);
            } else {
                console.log(`${YELLOW}🔚 Thread ending: Snipe all mode detected only${RESET}`);

                // ✅ FINISH TIMING TRACKING - DETECTED ONLY (SNIPE ALL)
                timingTracker.finishToken(tokenAddress, 'detected_only', {
                    matchType: 'Snipe All Mode',
                    matchedEntity: 'All tokens'
                });
            }

            return; // ✅ Thread ends here
        }

        // Check admin filtering
        if (botState.settings.enableAdminFilter) {
            console.log(`ADMIN FILTERING: Checking admin criteria`);

            // ========== 1. CHECK INDIVIDUAL TWITTER ADMIN ==========
            if (twitterData.admin && twitterData.type === 'individual') {
                console.log(`Checking individual Twitter admin: @${twitterData.handle}`);

                // ✅ DEBUG: Starting individual Twitter admin check
                debugMatchingProcess(tokenAddress, 'INDIVIDUAL_TWITTER_ADMIN_CHECK_START', {
                    twitterHandle: twitterData.handle,
                    primaryDetectionEnabled: botState.settings.enablePrimaryDetection,
                    secondaryDetectionEnabled: botState.settings.enableSecondaryDetection
                });

                // PRIMARY DETECTION (only if enabled)
                if (botState.settings.enablePrimaryDetection) {
                    const primaryAdminConfig = botState.checkAdminInPrimary(twitterData.handle);

                    // ✅ DEBUG: Primary Twitter admin check result
                    debugMatchingProcess(tokenAddress, 'PRIMARY_TWITTER_ADMIN_CHECK_RESULT', {
                        twitterHandle: twitterData.handle,
                        matchFound: !!primaryAdminConfig,
                        matchDetails: primaryAdminConfig ? {
                            id: primaryAdminConfig.id,
                            amount: primaryAdminConfig.amount,
                            fees: primaryAdminConfig.fees,
                            priorityFee: primaryAdminConfig.priorityFee
                        } : null
                    });

                    if (primaryAdminConfig) {
                        const matchTime = Date.now() - masterStartTime;

                        // ✅ DEBUG: Primary Twitter admin match found
                        debugMatchingProcess(tokenAddress, 'PRIMARY_TWITTER_ADMIN_MATCH_FOUND', {
                            twitterHandle: twitterData.handle,
                            matchTime: `${matchTime}ms`,
                            config: {
                                amount: primaryAdminConfig.amount,
                                fees: primaryAdminConfig.fees,
                                priorityFee: primaryAdminConfig.priorityFee
                            }
                        });

                        redLogger.separator();
                        redLogger.matchFound(
                            `@${twitterData.handle}`,
                            'PRIMARY TWITTER ADMIN (INDIVIDUAL)',
                            {
                                name: completeTokenData.name,
                                symbol: completeTokenData.symbol,
                                address: tokenAddress,
                                platform: platform
                            }
                        );
                        redLogger.info(`Detection Method: Individual Twitter Account Matching`);
                        redLogger.info(`Processing Time: ${matchTime}ms`);
                        redLogger.info(`Auto-Snipe Amount: ${primaryAdminConfig.amount} SOL`);
                        redLogger.separator();

                        logPrimaryMatch(
                            tokenAddress,
                            `@${twitterData.handle}`,
                            'twitter_individual',
                            matchTime,
                            'individual_twitter_account'
                        );

                        matchDetails = {
                            matchType: 'Primary Twitter Admin (Individual)',
                            matchedEntity: `@${twitterData.handle}`,
                            detectionMethod: 'Individual Twitter Account',
                            matchTime: `${matchTime}ms`
                        };

                        const detectedTokenData = {
                            ...completeTokenData,
                            matchType: 'primary_admin',
                            matchedEntity: twitterData.handle,
                            detectionReason: `Primary Admin: @${twitterData.handle}`,
                            config: primaryAdminConfig
                        };

                        botState.addDetectedToken(tokenAddress, detectedTokenData);

                        logTokenProcessingDecision(tokenAddress, 'detected', 'Primary Twitter admin match', {
                            admin: twitterData.handle,
                            platform,
                            name: completeTokenData.name
                        });

                        const processingEndTime = Date.now();
                        console.log(`PROCESSING COMPLETE: ${processingEndTime - masterStartTime}ms total`);

                        broadcastToClients({
                            type: 'token_detected',
                            data: detectedTokenData
                        });

                        if (!botState.settings.detectionOnlyMode) {
                            timingTracker.checkpoint(tokenAddress, 'snipeStart');
                            await snipeToken(tokenAddress, primaryAdminConfig);
                            timingTracker.checkpoint(tokenAddress, 'snipeEnd');

                            // ✅ DEBUG: Primary Twitter admin snipe completed
                            debugMatchingProcess(tokenAddress, 'PRIMARY_TWITTER_ADMIN_SNIPE_COMPLETED', {
                                twitterHandle: twitterData.handle,
                                totalTime: `${Date.now() - masterStartTime}ms`,
                                config: primaryAdminConfig
                            });

                            console.log(`${YELLOW}🔚 Thread ending: Primary individual Twitter admin sniped${RESET}`);

                            // ✅ FINISH TIMING TRACKING - SNIPED (INDIVIDUAL TWITTER)
                            timingTracker.finishToken(tokenAddress, 'sniped', matchDetails);
                        } else {
                            // ✅ DEBUG: Primary Twitter admin detected only
                            debugMatchingProcess(tokenAddress, 'PRIMARY_TWITTER_ADMIN_DETECTED_ONLY', {
                                twitterHandle: twitterData.handle,
                                totalTime: `${Date.now() - masterStartTime}ms`,
                                reason: 'Detection only mode enabled'
                            });

                            console.log(`${YELLOW}🔚 Thread ending: Primary individual Twitter admin detected only${RESET}`);

                            // ✅ FINISH TIMING TRACKING - DETECTED ONLY (INDIVIDUAL TWITTER)
                            timingTracker.finishToken(tokenAddress, 'detected_only', matchDetails);
                        }

                        return; // ✅ OUTCOME 2: Thread ends here
                    }
                }

                // SECONDARY DETECTION (only if enabled)
                if (botState.settings.enableSecondaryDetection) {
                    const secondaryAdminConfig = botState.checkAdminInSecondary(twitterData.handle);

                    // ✅ DEBUG: Secondary Twitter admin check result
                    debugMatchingProcess(tokenAddress, 'SECONDARY_TWITTER_ADMIN_CHECK_RESULT', {
                        twitterHandle: twitterData.handle,
                        matchFound: !!secondaryAdminConfig,
                        matchDetails: secondaryAdminConfig ? {
                            id: secondaryAdminConfig.id,
                            amount: secondaryAdminConfig.amount,
                            fees: secondaryAdminConfig.fees,
                            priorityFee: secondaryAdminConfig.priorityFee
                        } : null
                    });

                    if (secondaryAdminConfig) {
                        const matchTime = Date.now() - masterStartTime;

                        // ✅ DEBUG: Secondary Twitter admin match found
                        debugMatchingProcess(tokenAddress, 'SECONDARY_TWITTER_ADMIN_MATCH_FOUND', {
                            twitterHandle: twitterData.handle,
                            matchTime: `${matchTime}ms`,
                            config: {
                                amount: secondaryAdminConfig.amount,
                                fees: secondaryAdminConfig.fees,
                                priorityFee: secondaryAdminConfig.priorityFee
                            }
                        });

                        logSecondaryMatch(tokenAddress, twitterData.handle, matchTime);
                        logAdminMatchTiming(tokenAddress, twitterData.handle, 'secondary_admin_individual', matchTime);

                        console.log(`MATCH FOUND: Secondary admin @${twitterData.handle}`);

                        matchDetails = {
                            matchType: 'Secondary Twitter Admin (Individual)',
                            matchedEntity: `@${twitterData.handle}`,
                            detectionMethod: 'Individual Twitter Account',
                            matchTime: `${matchTime}ms`
                        };

                        const detectedTokenData = {
                            ...completeTokenData,
                            matchType: 'secondary_admin',
                            matchedEntity: twitterData.handle,
                            detectionReason: `Secondary Admin: @${twitterData.handle}`,
                            config: secondaryAdminConfig
                        };

                        botState.addDetectedToken(tokenAddress, detectedTokenData);

                        logTokenProcessingDecision(tokenAddress, 'detected', 'Secondary Twitter admin match', {
                            admin: twitterData.handle,
                            platform,
                            name: completeTokenData.name
                        });

                        broadcastToClients({
                            type: 'token_detected',
                            data: detectedTokenData
                        });

                        broadcastToClients({
                            type: 'secondary_popup_trigger',
                            data: {
                                tokenData: detectedTokenData,
                                globalSnipeSettings: botState.settings.globalSnipeSettings,
                                timestamp: new Date().toISOString()
                            }
                        });

                        // ✅ DEBUG: Secondary Twitter admin broadcast
                        debugMatchingProcess(tokenAddress, 'SECONDARY_TWITTER_ADMIN_BROADCAST', {
                            twitterHandle: twitterData.handle,
                            totalTime: `${Date.now() - masterStartTime}ms`,
                            config: secondaryAdminConfig
                        });

                        console.log(`${YELLOW}🔚 Thread ending: Secondary individual Twitter admin broadcast${RESET}`);

                        // ✅ FINISH TIMING TRACKING - DETECTED ONLY (SECONDARY INDIVIDUAL)
                        timingTracker.finishToken(tokenAddress, 'detected_only', matchDetails);

                        return; // ✅ OUTCOME 3: Thread ends here
                    }
                }

                // ✅ DEBUG: No individual Twitter admin matches
                debugMatchingProcess(tokenAddress, 'NO_INDIVIDUAL_TWITTER_ADMIN_MATCHES', {
                    twitterHandle: twitterData.handle,
                    primaryChecked: botState.settings.enablePrimaryDetection,
                    secondaryChecked: botState.settings.enableSecondaryDetection
                });

                console.log(`No match for Twitter admin @${twitterData.handle}`);
            }

            // ========== 2. CHECK TWITTER COMMUNITY ADMIN ==========
            if (twitterData.type === 'community' && twitterData.id) {
                console.log(`TWITTER COMMUNITY DETECTED: ${twitterData.id}`);

                // ✅ DEBUG: Starting community admin scraping
                debugMatchingProcess(tokenAddress, 'COMMUNITY_ADMIN_SCRAPING_START', {
                    communityId: twitterData.id,
                    enableCommunityReuse: botState.settings.enableCommunityReuse
                });

                if (botState.settings.enableCommunityReuse) {
                    const communityUsed = await isCommunityUsedInFirebase(twitterData.id);
                    if (communityUsed) {
                        console.log(`REJECTED: Community ${twitterData.id} already used`);
                        console.log(`${YELLOW}🔚 Thread ending: Community already used (filtered)${RESET}`);

                        // ✅ DEBUG: Community already used
                        debugMatchingProcess(tokenAddress, 'COMMUNITY_ALREADY_USED', {
                            communityId: twitterData.id,
                            reason: 'Community reuse prevention'
                        });

                        logTokenProcessingDecision(tokenAddress, 'rejected', 'Community already used', {
                            communityId: twitterData.id,
                            platform,
                            name: completeTokenData.name
                        });

                        // ✅ FINISH TIMING TRACKING - FILTERED (COMMUNITY REUSE)
                        timingTracker.finishToken(tokenAddress, 'filtered', {
                            filterReason: 'Community already used',
                            communityId: twitterData.id
                        });

                        return; // ✅ OUTCOME 1: Thread ends here
                    }
                    console.log(`Community ${twitterData.id} is NEW - continuing processing`);
                }

                console.log(`Scraping community ${twitterData.id} for admins...`);

                // ✅ Community scraping timing is tracked inside scrapeCommunityAndMatchAdmins
                const communityMatchResult = await scrapeCommunityAndMatchAdmins(twitterData.id, completeTokenData);

                // ✅ DEBUG: Community scraping completed
                debugMatchingProcess(tokenAddress, 'COMMUNITY_SCRAPING_COMPLETED', {
                    communityId: twitterData.id,
                    matchFound: !!communityMatchResult,
                    matchType: communityMatchResult?.matchType,
                    matchedEntity: communityMatchResult?.matchedEntity
                });

                if (communityMatchResult) {
                    console.log(`COMMUNITY MATCH FOUND: ${communityMatchResult.matchedEntity}`);

                    const detectedTokenData = {
                        ...completeTokenData,
                        matchType: communityMatchResult.matchType,
                        matchedEntity: communityMatchResult.matchedEntity,
                        detectionReason: communityMatchResult.detectionReason,
                        config: communityMatchResult.config
                    };

                    botState.addDetectedToken(tokenAddress, detectedTokenData);

                    await markCommunityAsUsedInFirebase(twitterData.id, detectedTokenData);

                    logTokenProcessingDecision(tokenAddress, 'detected', 'Community admin match', {
                        communityId: twitterData.id,
                        admin: communityMatchResult.matchedEntity,
                        matchType: communityMatchResult.matchType,
                        platform,
                        name: completeTokenData.name
                    });

                    broadcastToClients({
                        type: 'token_detected',
                        data: detectedTokenData
                    });

                    if (communityMatchResult && communityMatchResult.matchType === 'primary_admin') {
                        const matchTime = Date.now() - masterStartTime;

                        // ✅ DEBUG: Primary community admin match found
                        debugMatchingProcess(tokenAddress, 'PRIMARY_COMMUNITY_ADMIN_MATCH_FOUND', {
                            communityId: twitterData.id,
                            matchedAdmin: communityMatchResult.matchedEntity,
                            matchTime: `${matchTime}ms`,
                            config: communityMatchResult.config
                        });

                        redLogger.separator();
                        redLogger.matchFound(
                            communityMatchResult.matchedEntity,
                            'PRIMARY TWITTER ADMIN (COMMUNITY)',
                            {
                                name: completeTokenData.name,
                                symbol: completeTokenData.symbol,
                                address: tokenAddress,
                                platform: platform
                            }
                        );
                        redLogger.info(`Detection Method: Community Admin Scraping`);
                        redLogger.info(`Community ID: ${twitterData.id}`);
                        redLogger.info(`Processing Time: ${matchTime}ms`);
                        redLogger.info(`Auto-Snipe Amount: ${communityMatchResult.config.amount} SOL`);
                        redLogger.separator();

                        logPrimaryMatch(
                            tokenAddress,
                            communityMatchResult.matchedEntity,
                            'twitter_community',
                            matchTime,
                            'community_admin_scraping'
                        );

                        matchDetails = {
                            matchType: 'Primary Community Admin',
                            matchedEntity: communityMatchResult.matchedEntity,
                            detectionMethod: 'Community Admin Scraping',
                            communityId: twitterData.id,
                            matchTime: `${matchTime}ms`
                        };

                        if (!botState.settings.detectionOnlyMode) {
                            console.log('\n' + '🔥'.repeat(50));
                            console.log('🎯 PRIMARY MATCH - EXECUTING AUTO-SNIPE');
                            console.log('🔥'.repeat(50));
                            console.log(`Token: ${tokenAddress}`);
                            console.log(`Name: ${completeTokenData.name}`);
                            console.log(`Admin: ${communityMatchResult.matchedEntity}`);
                            console.log(`Amount: ${communityMatchResult.config.amount} SOL`);
                            console.log('🔥'.repeat(50) + '\n');

                            try {
                                timingTracker.checkpoint(tokenAddress, 'snipeStart');
                                const snipeResult = await snipeToken(tokenAddress, communityMatchResult.config);
                                timingTracker.checkpoint(tokenAddress, 'snipeEnd');

                                console.log("snipeResult : " + snipeResult);
                                if (snipeResult.success) {
                                    console.log(`✅ SNIPE SUCCESS! Signature: ${snipeResult.signature}`);
                                    console.log(`🔗 Explorer: https://solscan.io/tx/${snipeResult.signature}`);
                                } else {
                                    console.error(`❌ SNIPE FAILED: ${snipeResult.error}`);
                                }

                                // ✅ DEBUG: Primary community admin snipe completed
                                debugMatchingProcess(tokenAddress, 'PRIMARY_COMMUNITY_ADMIN_SNIPE_COMPLETED', {
                                    communityId: twitterData.id,
                                    matchedAdmin: communityMatchResult.matchedEntity,
                                    totalTime: `${Date.now() - masterStartTime}ms`,
                                    signature: snipeResult.signature
                                });

                                console.log(`${YELLOW}🔚 Thread ending: Primary community admin sniped${RESET}`);

                                // ✅ FINISH TIMING TRACKING - SNIPED (COMMUNITY)
                                timingTracker.finishToken(tokenAddress, 'sniped', matchDetails);
                            } catch (snipeError) {
                                console.error(`❌ SNIPE EXECUTION ERROR: ${snipeError.message}`);
                                console.error('Stack:', snipeError.stack);

                                // ✅ DEBUG: Snipe execution error
                                debugMatchingProcess(tokenAddress, 'SNIPE_EXECUTION_ERROR', {
                                    communityId: twitterData.id,
                                    matchedAdmin: communityMatchResult.matchedEntity,
                                    error: snipeError.message
                                });

                                console.log(`${YELLOW}🔚 Thread ending: Snipe failed with error${RESET}`);

                                // ✅ FINISH TIMING TRACKING - ERROR (SNIPE FAILED)
                                timingTracker.finishToken(tokenAddress, 'error', {
                                    ...matchDetails,
                                    error: snipeError.message
                                });
                            }
                        } else {
                            console.log('🛡️ DETECTION ONLY MODE - Snipe execution skipped');
                            console.log(`${YELLOW}🔚 Thread ending: Primary community admin detected only${RESET}`);

                            // ✅ FINISH TIMING TRACKING - DETECTED ONLY (COMMUNITY PRIMARY)
                            timingTracker.finishToken(tokenAddress, 'detected_only', matchDetails);
                        }
                        return; // ✅ OUTCOME 2: Thread ends here
                    } else if (communityMatchResult.matchType === 'secondary_admin') {
                        const matchTime = Date.now() - masterStartTime;

                        // ✅ DEBUG: Secondary community admin match found
                        debugMatchingProcess(tokenAddress, 'SECONDARY_COMMUNITY_ADMIN_MATCH_FOUND', {
                            communityId: twitterData.id,
                            matchedAdmin: communityMatchResult.matchedEntity,
                            matchTime: `${matchTime}ms`,
                            config: communityMatchResult.config
                        });

                        logSecondaryMatch(tokenAddress, communityMatchResult.matchedEntity, matchTime);

                        matchDetails = {
                            matchType: 'Secondary Community Admin',
                            matchedEntity: communityMatchResult.matchedEntity,
                            detectionMethod: 'Community Admin Scraping',
                            communityId: twitterData.id,
                            matchTime: `${matchTime}ms`
                        };

                        broadcastToClients({
                            type: 'secondary_popup_trigger',
                            data: {
                                tokenData: detectedTokenData,
                                globalSnipeSettings: botState.settings.globalSnipeSettings,
                                timestamp: new Date().toISOString()
                            }
                        });

                        console.log(`${YELLOW}🔚 Thread ending: Secondary community admin broadcast${RESET}`);

                        // ✅ FINISH TIMING TRACKING - DETECTED ONLY (COMMUNITY SECONDARY)
                        timingTracker.finishToken(tokenAddress, 'detected_only', matchDetails);

                        return; // ✅ OUTCOME 3: Thread ends here
                    }
                } else {
                    console.log(`No admin matches found in community ${twitterData.id}`);

                    // ✅ DEBUG: No community admin matches
                    debugMatchingProcess(tokenAddress, 'NO_COMMUNITY_ADMIN_MATCHES', {
                        communityId: twitterData.id,
                        reason: 'No matching admins found in scraped community'
                    });
                }
            }

            // ✅ DEBUG: No admin matches found at all
            debugMatchingProcess(tokenAddress, 'NO_ADMIN_MATCHES_FINAL', {
                checkedWallet: !!creatorWallet,
                checkedTwitter: !!twitterData.type,
                twitterType: twitterData.type,
                twitterHandle: twitterData.handle,
                twitterCommunityId: twitterData.id,
                enableAdminFilter: botState.settings.enableAdminFilter
            });

            console.log(`\nFILTERED OUT: Token doesn't match any admin criteria`);
            console.log(`  Checked Twitter: ${twitterData.type || 'N/A'}`);
            console.log(`  Checked Wallet: ${creatorWallet ? 'Yes' : 'No'}`);
            console.log(`${YELLOW}🔚 Thread ending: No admin matches (filtered)${RESET}`);

            logTokenProcessingDecision(tokenAddress, 'filtered', 'No admin match', {
                hadTwitter: !!twitterData.type,
                hadWallet: !!creatorWallet,
                twitterUrl: enhancedData.twitterUrl,
                platform,
                name: completeTokenData.name
            });

            // ✅ FINISH TIMING TRACKING - FILTERED (NO MATCH)
            timingTracker.finishToken(tokenAddress, 'filtered', {
                filterReason: 'No admin match',
                checkedTwitter: twitterData.type || 'none',
                checkedWallet: !!creatorWallet
            });

            return; // ✅ OUTCOME 1: Thread ends here
        }

        // ========== NO FILTERING - DETECT ALL ==========
        if (!botState.settings.enableAdminFilter) {
            console.log(`NO FILTERING: Admin filter disabled - detecting all tokens`);

            // ✅ DEBUG: No filtering mode activated
            debugMatchingProcess(tokenAddress, 'NO_FILTERING_MODE_ACTIVATED', {
                name: completeTokenData.name,
                symbol: completeTokenData.symbol,
                detectionOnlyMode: botState.settings.detectionOnlyMode
            });

            const detectedTokenData = {
                ...completeTokenData,
                matchType: 'no_filters',
                matchedEntity: 'No filters active',
                detectionReason: 'Admin filtering disabled'
            };

            botState.addDetectedToken(tokenAddress, detectedTokenData);

            logTokenProcessingDecision(tokenAddress, 'detected', 'No filters active', {
                platform,
                name: completeTokenData.name
            });

            broadcastToClients({
                type: 'token_detected',
                data: detectedTokenData
            });

            if (!botState.settings.detectionOnlyMode) {
                timingTracker.checkpoint(tokenAddress, 'snipeStart');
                await snipeToken(tokenAddress, botState.settings.globalSnipeSettings);
                timingTracker.checkpoint(tokenAddress, 'snipeEnd');

                console.log(`${YELLOW}🔚 Thread ending: No filters mode sniped${RESET}`);

                matchDetails = {
                    matchType: 'No Filters',
                    matchedEntity: 'All tokens',
                    detectionMethod: 'No filtering'
                };

                // ✅ FINISH TIMING TRACKING - SNIPED (NO FILTERS)
                timingTracker.finishToken(tokenAddress, 'sniped', matchDetails);
            } else {
                console.log(`${YELLOW}🔚 Thread ending: No filters mode detected only${RESET}`);

                // ✅ FINISH TIMING TRACKING - DETECTED ONLY (NO FILTERS)
                timingTracker.finishToken(tokenAddress, 'detected_only', {
                    matchType: 'No Filters',
                    matchedEntity: 'All tokens'
                });
            }

            return; // ✅ Thread ends here
        }

        // ✅ DEBUG: Processing complete - unexpected state
        debugMatchingProcess(tokenAddress, 'PROCESSING_COMPLETE_UNEXPECTED_STATE', {
            enableAdminFilter: botState.settings.enableAdminFilter,
            snipeAllTokens: botState.settings.snipeAllTokens,
            detectionOnlyMode: botState.settings.detectionOnlyMode,
            finalState: 'Unexpected - no matching conditions met'
        });

    } catch (error) {
        // ✅ DEBUG: Error in processing
        debugMatchingProcess(tokenAddress, 'PROCESSING_ERROR', {
            error: error.message,
            stack: error.stack
        });

        console.error('❌ Error in token processing:', error);
        console.error('Stack:', error.stack);
        console.log(`${YELLOW}🔚 Thread ending: Fatal error${RESET}`);

        // ✅ FINISH TIMING TRACKING - ERROR
        timingTracker.finishToken(tokenAddress, 'error', {
            error: error.message,
            stack: error.stack.split('\n')[0]
        });

        return; // ✅ Thread ends on error
    }
}

// Helper function for logging deciasions
function logTokenProcessingDecision(tokenAddress, decision, reason, data = {}) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        tokenAddress,
        decision,
        reason,
        ...data
    };

    console.log(`\nTOKEN DECISION: ${decision.toUpperCase()}`);
    console.log(`Reason: ${reason}`);
    if (Object.keys(data).length > 0) {
        console.log(`Additional data:`, data);
    }

    // Append to decisions log file
    try {
        fs.appendFileSync(
            path.join(__dirname, 'token_decisions.log'),
            JSON.stringify(logEntry) + '\n'
        );
    } catch (error) {
        console.error('Failed to write to token_decisions.log:', error.message);
    }
}

// New helper function for enhanced Bonk metadata fetching
async function fetchEnhancedBonkMetadata(tokenAddress, tokenData) {
    try {
        // Try multiple APIs with proper error handling

        // 1. Try Token Metadata Extractor
        try {
            const completeMetadata = await tokenMetadataExtractor.getCompleteTokenMetadata(tokenAddress, true);
            const bestMetadata = tokenMetadataExtractor.getBestMetadata(completeMetadata);

            if (bestMetadata && bestMetadata.name !== 'Unknown') {
                return {
                    name: bestMetadata.name,
                    symbol: bestMetadata.symbol,
                    description: bestMetadata.description,
                    imageUrl: bestMetadata.logoURI !== 'Not found' ? bestMetadata.logoURI : null,
                    twitterUrl: bestMetadata.twitter !== 'Not available' ? bestMetadata.twitter : null,
                    website: bestMetadata.website !== 'Not available' ? bestMetadata.website : null,
                    hasEnhancedData: true
                };
            }
        } catch (error) {
            console.log(`[METADATA-FALLBACK] Token extractor failed: ${error.message}`);
        }

        // 2. Try direct Helius API
        if (process.env.HELIUS_RPC) {
            try {
                const axios = require('axios');
                const heliusUrl = `https://api.helius.xyz/v0/token-metadata?api-key=${process.env.HELIUS_RPC.split('api-key=')[1]}`;
                const response = await axios.post(heliusUrl, {
                    mintAccounts: [tokenAddress],
                    includeOffChain: true,
                    disableCache: false
                }, { timeout: 3000 });

                if (response.data && response.data[0]) {
                    const data = response.data[0];
                    return {
                        name: data.onChainMetadata?.metadata?.data?.name || data.legacyMetadata?.name || 'Unknown',
                        symbol: data.onChainMetadata?.metadata?.data?.symbol || data.legacyMetadata?.symbol || 'BONK',
                        description: data.offChainMetadata?.metadata?.description || null,
                        imageUrl: data.offChainMetadata?.metadata?.image || data.legacyMetadata?.logoURI || null,
                        twitterUrl: data.offChainMetadata?.metadata?.twitter || null,
                        website: data.offChainMetadata?.metadata?.website || null,
                        hasEnhancedData: true
                    };
                }
            } catch (error) {
                console.log(`[METADATA-FALLBACK] Helius API failed: ${error.message}`);
            }
        }

        // 3. Return basic data if all fails
        return {
            name: tokenData.name || 'Unknown',
            symbol: tokenData.symbol || 'Unknown',
            description: null,
            imageUrl: tokenData.uri || null,
            twitterUrl: null,
            website: null,
            hasEnhancedData: false
        };

    } catch (error) {
        console.log(`[METADATA-ERROR] All metadata fetching failed: ${error.message}`);
        return null;
    }
}

// Enhanced Twitter data extraction function that handles all possible formats
function extractTwitterDataRobust(input, sourceType = 'unknown') {
    if (!input) return { type: null, id: null, handle: null, source: sourceType };

    console.log(`🔍 Extracting Twitter data from: "${input}" (source: ${sourceType})`);

    const cleanInput = input.trim();

    // Pattern 1: Tweet/Status URLs - ADD THIS PATTERN FIRST
    const tweetPatterns = [
        /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com\/|x\.com\/)([a-zA-Z0-9_]+)\/status\/(\d+)/i,
    ];

    for (const pattern of tweetPatterns) {
        const match = cleanInput.match(pattern);
        if (match) {
            console.log(`📱 Found tweet: @${match[1]} - Tweet ID: ${match[2]}`);
            return {
                type: 'tweet',
                id: match[2], // Tweet ID
                handle: match[1].toLowerCase(), // Username
                source: sourceType,
                originalUrl: cleanInput
            };
        }
    }

    // Pattern 2: Community ID in various formats
    const communityPatterns = [
        /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com\/|x\.com\/)i\/communities\/(\d+)/i,
        /^i\/communities\/(\d+)$/i,
        /communities\/(\d+)/i
    ];

    for (const pattern of communityPatterns) {
        const match = cleanInput.match(pattern);
        if (match) {
            console.log(`🏘️ Found community ID: ${match[1]} (pattern: ${pattern})`);
            return {
                type: 'community',
                id: match[1],
                handle: null,
                source: sourceType,
                originalUrl: cleanInput
            };
        }
    }

    // Pattern 3: Individual Twitter accounts
    const userPatterns = [
        /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com\/|x\.com\/)(?!i\/communities\/)(?!.*\/status\/)([a-zA-Z0-9_]+)/i,
        /^@([a-zA-Z0-9_]+)$/,
        /^([a-zA-Z0-9_]{1,15})$/
    ];

    for (const pattern of userPatterns) {
        const match = cleanInput.match(pattern);
        if (match) {
            const handle = match[1].toLowerCase();
            if (isValidTwitterHandle(handle)) {
                console.log(`👤 Found individual handle: @${handle} (pattern: ${pattern})`);
                return {
                    type: 'individual',
                    id: null,
                    handle: handle,
                    source: sourceType,
                    originalUrl: cleanInput
                };
            }
        }
    }

    console.log(`❌ No Twitter data found in: "${input}"`);
    return { type: null, id: null, handle: null, source: sourceType };
}

// Enhanced validation for Twitter handles
function isValidTwitterHandle(handle) {
    if (!handle || handle.length < 1 || handle.length > 15) return false;

    // Must only contain alphanumeric and underscore
    if (!/^[a-zA-Z0-9_]+$/.test(handle)) return false;

    // Block common non-username terms
    const blockedTerms = [
        'home', 'explore', 'messages', 'follow', 'click', 'search',
        'notifications', 'profile', 'settings', 'logout', 'help',
        'about', 'privacy', 'terms', 'status', 'intent', 'share'
    ];

    if (blockedTerms.includes(handle.toLowerCase())) return false;

    return true;
}

// Helper function to get nested object values safely
function getNestedValue(obj, path) {
    try {
        return path.split('.').reduce((current, key) => {
            if (key.includes('?')) {
                key = key.replace('?', '');
                return current?.[key];
            }
            return current[key];
        }, obj);
    } catch (error) {
        return undefined;
    }
}

app.get('/api/debug/matching-logs', (req, res) => {
    try {
        const debugLogFile = path.join(__dirname, 'matching_debug.log');
        if (fs.existsSync(debugLogFile)) {
            const logContent = fs.readFileSync(debugLogFile, 'utf8');
            const lines = logContent.trim().split('\n');
            const logs = lines.map(line => {
                try {
                    return JSON.parse(line);
                } catch (e) {
                    return { raw: line };
                }
            }).reverse(); // Most recent first

            res.json({
                success: true,
                logs: logs.slice(0, 100), // Last 100 entries
                total: logs.length
            });
        } else {
            res.json({
                success: true,
                logs: [],
                total: 0,
                message: 'No debug logs yet'
            });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Add endpoint to clear debug logs
app.delete('/api/debug/matching-logs', (req, res) => {
    try {
        const debugLogFile = path.join(__dirname, 'matching_debug.log');
        if (fs.existsSync(debugLogFile)) {
            fs.unlinkSync(debugLogFile);
        }
        res.json({ success: true, message: 'Debug logs cleared' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// ========== API ENDPOINTS ==========

// ========== TWEET/COMMUNITY STATUS ENDPOINTS ==========
app.get('/api/twitter-usage-status', async (req, res) => {
    try {
        // Get cache stats
        const tweetStats = {
            totalCachedTweets: tweetCache.tweets.size,
            pendingFirebaseSync: tweetCache.pendingSync.size,
            lastSyncTime: tweetCache.lastSyncToFirebase
        };

        const communityStats = {
            totalCachedCommunities: communityCache.communities.size,
            pendingFirebaseSync: communityCache.pendingSync.size,
            lastSyncTime: communityCache.lastSyncToFirebase
        };

        // Get Firebase collection sizes
        const tweetSnapshot = await db.collection('usedTweets').get();
        const communitySnapshot = await db.collection('usedCommunities').get();

        res.json({
            success: true,
            cache: {
                tweets: tweetStats,
                communities: communityStats
            },
            firebase: {
                tweets: {
                    totalDocuments: tweetSnapshot.size,
                    recentTweets: tweetSnapshot.docs.slice(0, 5).map(doc => ({
                        id: doc.id,
                        data: doc.data()
                    }))
                },
                communities: {
                    totalDocuments: communitySnapshot.size,
                    recentCommunities: communitySnapshot.docs.slice(0, 5).map(doc => ({
                        id: doc.id,
                        data: doc.data()
                    }))
                }
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Add this endpoint after your other API routes (around line 2100):

app.post('/api/test-direct-buy', async (req, res) => {
    try {
        const { tokenAddress, amount = 0.0005 } = req.body;

        if (!tokenAddress) {
            return res.status(400).json({ error: 'Token address required' });
        }

        console.log('🧪 TESTING DIRECT BUY');
        console.log(`Token: ${tokenAddress}`);
        console.log(`Amount: ${amount} SOL`);

        // Get bonding curve
        const { PublicKey } = require('@solana/web3.js');
        const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
        const mintPublicKey = new PublicKey(tokenAddress);
        const [bondingCurve] = PublicKey.findProgramAddressSync(
            [Buffer.from("bonding-curve"), mintPublicKey.toBytes()],
            PUMP_FUN_PROGRAM
        );

        const params = {
            mint: tokenAddress,
            bondingCurveAddress: bondingCurve.toString(),
            amount: amount,
            priorityFee: config.priorityFee,
            slippage: 1000
        };

        const result = await executeDirectBondingCurveBuy(params);

        res.json({
            success: true,
            signature: result.signature,
            explorerUrl: `https://solscan.io/tx/${result.signature}`
        });

    } catch (error) {
        console.error('Test failed:', error);
        res.status(500).json({ error: error.message });
    }
});

// ========== DIAGNOSTIC ENDPOINT FOR LET'S BONK TOKEN DATA ==========
app.post('/api/debug/inspect-letsbonk-token', async (req, res) => {
    try {
        const { tokenAddress } = req.body;

        if (!tokenAddress) {
            return res.status(400).json({ error: 'Token address is required' });
        }

        console.log('\n' + '='.repeat(80));
        console.log('🦎 LET\'S BONK TOKEN DATA INSPECTION');
        console.log('='.repeat(80));
        console.log(`Token Address: ${tokenAddress}`);

        // Step 1: Check if this token is in detected tokens (from websocket)
        const detectedToken = botState.detectedTokens.get(tokenAddress);

        console.log('\n--- STEP 1: WEBSOCKET DATA (if available) ---');
        if (detectedToken) {
            console.log('✅ Token found in detected tokens');
            console.log('Raw websocket data:', JSON.stringify(detectedToken, null, 2));
            console.log('\nKey fields:');
            console.log(`  - bondingCurveAddress: ${detectedToken.bondingCurveAddress || 'NOT PRESENT'}`);
            console.log(`  - bondingCurveKey: ${detectedToken.bondingCurveKey || 'NOT PRESENT'}`);
            console.log(`  - pool: ${detectedToken.pool || 'NOT PRESENT'}`);
            console.log(`  - platform: ${detectedToken.platform || 'NOT PRESENT'}`);
        } else {
            console.log('⚠️ Token not found in detected tokens (may not have been received via websocket yet)');
        }

        // Step 2: Fetch metadata from backend
        console.log('\n--- STEP 2: BACKEND METADATA FETCH ---');
        console.log('Fetching enhanced metadata...');

        const metadata = await globalRateLimiter.executeWithRateLimit(() =>
            tokenMetadataExtractor.getCompleteTokenMetadata(tokenAddress)
        );

        console.log('Backend metadata sources checked:');
        console.log(`  - GeckoTerminal: ${metadata.geckoTerminalInfo ? '✅' : '❌'}`);
        console.log(`  - Birdeye: ${metadata.birdeyeInfo ? '✅' : '❌'}`);
        console.log(`  - Jupiter: ${metadata.jupiterInfo ? '✅' : '❌'}`);
        console.log(`  - Solana Registry: ${metadata.registryInfo ? '✅' : '❌'}`);
        console.log(`  - On-chain Metaplex: ${metadata.onChainMetadata ? '✅' : '❌'}`);

        // Step 3: Check for bonding curve in metadata
        console.log('\n--- STEP 3: BONDING CURVE SEARCH ---');

        const bondingCurveLocations = {
            websocket_bondingCurveAddress: detectedToken?.bondingCurveAddress,
            websocket_bondingCurveKey: detectedToken?.bondingCurveKey,
            metadata_root: metadata.bondingCurveAddress || metadata.bondingCurveKey,
            geckoTerminal: metadata.geckoTerminalInfo?.bondingCurve,
            birdeye: metadata.birdeyeInfo?.bondingCurve,
            jupiter: metadata.jupiterInfo?.bondingCurve
        };

        console.log('Bonding curve search results:');
        Object.entries(bondingCurveLocations).forEach(([source, value]) => {
            console.log(`  ${source}: ${value || '❌ NOT FOUND'}`);
        });

        const foundBondingCurve = Object.values(bondingCurveLocations).find(v => v);

        // Step 4: Try DexScreener pair address
        console.log('\n--- STEP 4: DEXSCREENER PAIR ADDRESS ---');
        let pairData = null;
        try {
            pairData = await getPairAddressFromDexScreener(tokenAddress);
            if (pairData) {
                console.log('✅ DexScreener pair found:');
                console.log(`  Pair Address: ${pairData.pairAddress}`);
                console.log(`  DEX: ${pairData.dexId}`);
                console.log(`  Liquidity: ${JSON.stringify(pairData.liquidity)}`);
            } else {
                console.log('❌ No pair found on DexScreener');
            }
        } catch (error) {
            console.log(`❌ DexScreener error: ${error.message}`);
        }

        // Step 5: Try calculating bonding curve (Pump.fun method)
        console.log('\n--- STEP 5: BONDING CURVE CALCULATION (PUMP.FUN METHOD) ---');
        let calculatedBondingCurve = null;
        try {
            const { PublicKey } = require('@solana/web3.js');
            const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
            const mintPublicKey = new PublicKey(tokenAddress);
            const [bondingCurve] = PublicKey.findProgramAddressSync(
                [Buffer.from("bonding-curve"), mintPublicKey.toBytes()],
                PUMP_FUN_PROGRAM
            );
            calculatedBondingCurve = bondingCurve.toString();
            console.log(`✅ Calculated bonding curve: ${calculatedBondingCurve}`);
        } catch (error) {
            console.log(`❌ Bonding curve calculation failed: ${error.message}`);
        }

        // Summary
        console.log('\n' + '='.repeat(80));
        console.log('📊 SUMMARY');
        console.log('='.repeat(80));
        console.log(`Token: ${tokenAddress}`);
        console.log(`Platform: ${detectedToken?.platform || 'Unknown'}`);
        console.log(`Pool Type: ${detectedToken?.pool || 'Unknown'}`);
        console.log(`\nBonding Curve Availability:`);
        console.log(`  From Websocket: ${detectedToken?.bondingCurveAddress ? '✅ YES' : '❌ NO'}`);
        console.log(`  From Metadata: ${foundBondingCurve ? '✅ YES' : '❌ NO'}`);
        console.log(`  From DexScreener: ${pairData ? '✅ YES' : '❌ NO'}`);
        console.log(`  Calculated: ${calculatedBondingCurve ? '✅ YES' : '❌ NO'}`);
        console.log('='.repeat(80) + '\n');

        // Return comprehensive response
        res.json({
            success: true,
            tokenAddress,
            analysis: {
                websocketData: {
                    available: !!detectedToken,
                    bondingCurveAddress: detectedToken?.bondingCurveAddress,
                    bondingCurveKey: detectedToken?.bondingCurveKey,
                    platform: detectedToken?.platform,
                    pool: detectedToken?.pool,
                    fullData: detectedToken
                },
                backendMetadata: {
                    sources: {
                        geckoTerminal: !!metadata.geckoTerminalInfo,
                        birdeye: !!metadata.birdeyeInfo,
                        jupiter: !!metadata.jupiterInfo,
                        registry: !!metadata.registryInfo,
                        onChain: !!metadata.onChainMetadata
                    },
                    bondingCurveLocations,
                    foundBondingCurve
                },
                dexScreener: {
                    available: !!pairData,
                    pairAddress: pairData?.pairAddress,
                    dexId: pairData?.dexId,
                    fullData: pairData
                },
                calculated: {
                    bondingCurveAddress: calculatedBondingCurve,
                    method: 'pump_fun_pda_calculation'
                }
            },
            recommendation: {
                hasBondingCurve: !!(detectedToken?.bondingCurveAddress || foundBondingCurve || calculatedBondingCurve),
                preferredSource: detectedToken?.bondingCurveAddress ? 'websocket' :
                    foundBondingCurve ? 'metadata' :
                        calculatedBondingCurve ? 'calculated' :
                            pairData ? 'dexscreener' : 'none',
                addressToUse: detectedToken?.bondingCurveAddress ||
                    foundBondingCurve ||
                    calculatedBondingCurve ||
                    pairData?.pairAddress ||
                    null
            }
        });

    } catch (error) {
        console.error('❌ Inspection error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            stack: error.stack
        });
    }
});

app.post('/api/check-tweet-status/:tweetId', async (req, res) => {
    try {
        const { tweetId } = req.params;

        // Check cache
        const inCache = tweetCache.tweets.has(tweetId);
        const cacheData = tweetCache.tweets.get(tweetId);

        // Check Firebase
        const firebaseDoc = await db.collection('usedTweets').doc(tweetId).get();
        const inFirebase = firebaseDoc.exists;
        const firebaseData = firebaseDoc.data();

        res.json({
            success: true,
            tweetId,
            status: {
                inCache,
                inFirebase,
                isPending: tweetCache.pendingSync.has(tweetId)
            },
            data: {
                cache: cacheData || null,
                firebase: firebaseData || null
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Global snipe settings API endpoints
app.post('/api/global-snipe-settings', async (req, res) => {
    const { amount, fees, mevProtection, soundNotification, priorityFee, updateExistingAdmins } = req.body;

    console.log('\n' + '🔧'.repeat(40));
    console.log('GLOBAL SNIPE SETTINGS UPDATE REQUEST:');
    console.log(`   Received amount: ${amount} (type: ${typeof amount})`);
    console.log(`   Received fees: ${fees}`);
    console.log(`   Received mevProtection: ${mevProtection}`);
    console.log(`   Received soundNotification: ${soundNotification}`);
    console.log(`   Received priorityFee: ${priorityFee}`);
    console.log('🔧'.repeat(40) + '\n');

    // ✅ FIX: Use typeof check instead of truthy check
    // This ensures even 0 or small decimal values get updated
    if (typeof amount !== 'undefined') {
        console.log(`✅ Updating amount from ${botState.settings.globalSnipeSettings.amount} to ${amount}`);
        botState.settings.globalSnipeSettings.amount = amount;
    }

    if (typeof fees !== 'undefined') {
        console.log(`✅ Updating fees from ${botState.settings.globalSnipeSettings.fees} to ${fees}`);
        botState.settings.globalSnipeSettings.fees = fees;
    }

    if (typeof mevProtection !== 'undefined') {
        console.log(`✅ Updating mevProtection from ${botState.settings.globalSnipeSettings.mevProtection} to ${mevProtection}`);
        botState.settings.globalSnipeSettings.mevProtection = mevProtection;
    }

    if (typeof soundNotification !== 'undefined') {
        console.log(`✅ Updating soundNotification from ${botState.settings.globalSnipeSettings.soundNotification} to ${soundNotification}`);
        botState.settings.globalSnipeSettings.soundNotification = soundNotification;
    }

    if (typeof priorityFee !== 'undefined') {
        console.log(`✅ Updating priorityFee from ${botState.settings.globalSnipeSettings.priorityFee} to ${priorityFee}`);
        botState.settings.globalSnipeSettings.priorityFee = priorityFee;
    }

    console.log('\n' + '📊'.repeat(40));
    console.log('UPDATED GLOBAL SNIPE SETTINGS:');
    console.log(JSON.stringify(botState.settings.globalSnipeSettings, null, 2));
    console.log('📊'.repeat(40) + '\n');

    // ✅ NEW: Option to update all existing Primary Admin entries
    if (updateExistingAdmins) {
        let updatedCount = 0;

        // Update all Primary Admin entries with new global settings
        for (const [id, config] of botState.primaryAdminList.entries()) {
            if (typeof amount !== 'undefined') config.amount = amount;
            if (typeof fees !== 'undefined') config.fees = fees;
            if (typeof mevProtection !== 'undefined') config.mevProtection = mevProtection;
            if (typeof soundNotification !== 'undefined') config.soundNotification = soundNotification;

            // Save each updated entry to Firebase
            await saveAdminListToFirebase('primary_admins', config);
            updatedCount++;
        }

        console.log(`✅ Updated ${updatedCount} Primary Admin entries with new global settings`);

        // Broadcast update to clients
        broadcastToClients({
            type: 'admin_list_bulk_updated',
            data: {
                listType: 'primary_admins',
                updatedCount,
                globalSnipeSettings: botState.settings.globalSnipeSettings,
                timestamp: new Date().toISOString()
            }
        });
    }

    res.json({
        success: true,
        globalSnipeSettings: botState.settings.globalSnipeSettings,
        updatedExistingAdmins: updateExistingAdmins || false,
        updatedCount: updateExistingAdmins ? botState.primaryAdminList.size : 0
    });
});


// Add this endpoint after the existing /api/global-snipe-settings endpoint (around line 1750)

app.post('/api/update-existing-admins-amounts', async (req, res) => {
    try {
        const { amount, fees } = req.body;  // ✅ ADD fees parameter

        console.log(`🔄 Updating all existing admin amounts to ${amount} SOL and fees to ${fees}%`);

        let primaryUpdated = 0;
        let secondaryUpdated = 0;

        // Update Primary Admins
        for (const [id, config] of botState.primaryAdminList.entries()) {
            config.amount = amount;
            if (fees !== undefined) config.fees = fees;  // ✅ ADD THIS
            await saveAdminListToFirebase('primary_admins', config);
            primaryUpdated++;
        }

        // Update Secondary Admins
        for (const [id, config] of botState.secondaryAdminList.entries()) {
            config.amount = amount;
            if (fees !== undefined) config.fees = fees;  // ✅ ADD THIS
            await saveAdminListToFirebase('secondary_admins', config);
            secondaryUpdated++;
        }

        console.log(`✅ Updated ${primaryUpdated} primary and ${secondaryUpdated} secondary admins`);

        // Broadcast update to all clients
        broadcastToClients({
            type: 'admin_amounts_bulk_updated',
            data: {
                amount,
                fees,  // ✅ ADD THIS
                primaryUpdated,
                secondaryUpdated,
                timestamp: new Date().toISOString()
            }
        });

        res.json({
            success: true,
            amount,
            fees,  // ✅ ADD THIS
            primaryUpdated,
            secondaryUpdated,
            message: `Updated ${primaryUpdated + secondaryUpdated} total admin entries`
        });

    } catch (error) {
        console.error('❌ Error updating admin amounts:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// In your frontend settings page
const saveGlobalSnipeSettings = async () => {
    const response = await fetch('/api/global-snipe-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            amount: globalAmount,
            fees: globalFees,
            mevProtection: globalMevProtection,
            soundNotification: globalSound,
            updateExistingAdmins: true  // ✅ Add this flag to update existing entries
        })
    });

    const data = await response.json();

    if (data.success) {
        console.log(`✅ Updated global settings and ${data.updatedCount} existing Primary Admin entries`);
    }
};

app.post('/api/twitter-logout', async (req, res) => {
    try {
        if (!twitterScraper.isInitialized) {
            return res.status(400).json({ error: 'Twitter scraper not initialized' });
        }

        // If browser crashed or closed, reinitialize it first
        if (!twitterScraper.browser || !twitterScraper.page) {
            console.log('🔄 Browser crashed, reinitializing...');
            const initSuccess = await twitterScraper.init();
            if (!initSuccess) {
                return res.status(500).json({ error: 'Failed to reinitialize browser' });
            }
        }

        let logoutSuccess = false;

        // Navigate to logout page and perform logout
        if (twitterScraper.page) {
            try {
                console.log('🚪 Starting Twitter logout process...');

                // Step 1: Go to logout page
                await twitterScraper.page.goto('https://twitter.com/logout', {
                    waitUntil: 'networkidle',
                    timeout: 30000
                });

                await twitterScraper.page.waitForTimeout(2000);

                // Step 2: Try to auto-click logout confirmation
                try {
                    console.log('🔍 Looking for logout confirmation button...');
                    const logoutButton = await twitterScraper.page.waitForSelector(
                        '[data-testid="confirmationSheetConfirm"]',
                        { timeout: 5000 }
                    );

                    if (logoutButton) {
                        console.log('✅ Found logout button, clicking...');
                        await logoutButton.click();
                        await twitterScraper.page.waitForTimeout(3000);

                        // Step 3: Check if we're actually logged out
                        const currentUrl = twitterScraper.page.url();
                        console.log('🔍 Current URL after logout:', currentUrl);

                        // Look for login indicators
                        try {
                            await twitterScraper.page.waitForSelector('[data-testid="loginButton"]', { timeout: 5000 });
                            console.log('✅ Login button found - logout successful');
                            logoutSuccess = true;
                        } catch (e) {
                            // If login button not found, check URL
                            if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login')) {
                                console.log('✅ Redirected to login page - logout successful');
                                logoutSuccess = true;
                            }
                        }
                    }
                } catch (e) {
                    console.log('⚠️ No logout confirmation button found');

                    // Check if we're already on login page
                    const currentUrl = twitterScraper.page.url();
                    if (currentUrl.includes('/login')) {
                        console.log('✅ Already on login page - logout successful');
                        logoutSuccess = true;
                    }
                }

                // Step 4: If auto-logout failed, try direct navigation to login
                if (!logoutSuccess) {
                    console.log('🔄 Auto-logout failed, trying direct login navigation...');
                    await twitterScraper.page.goto('https://twitter.com/i/flow/login', {
                        waitUntil: 'networkidle',
                        timeout: 30000
                    });

                    // Check if we reached login page
                    const finalUrl = twitterScraper.page.url();
                    if (finalUrl.includes('/login') || finalUrl.includes('/i/flow/login')) {
                        console.log('✅ Successfully navigated to login page');
                        logoutSuccess = true;
                    }
                }

            } catch (e) {
                console.log('⚠️ Error during logout navigation:', e.message);
            }
        }

        // Reset session state regardless of logout success
        twitterScraper.sessionActive = false;

        const message = logoutSuccess ?
            'Successfully logged out from Twitter' :
            'Logout page opened - please complete logout manually in browser';

        res.json({
            success: true,
            loggedOut: logoutSuccess,
            message: message
        });

    } catch (error) {
        console.error('❌ Logout error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/twitter-reopen-browser', async (req, res) => {
    try {
        console.log('🔄 Reopening Twitter browser...');

        // Close existing browser if any
        if (twitterScraper.browser) {
            try {
                await twitterScraper.browser.close();
            } catch (e) {
                console.log('Old browser already closed');
            }
        }

        // Reinitialize
        const initSuccess = await twitterScraper.init();
        if (initSuccess) {
            // Open Twitter login page
            await twitterScraper.openLoginPage();
            res.json({
                success: true,
                message: 'Browser reopened and Twitter login page loaded'
            });
        } else {
            res.status(500).json({ error: 'Failed to reopen browser' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/snipe-with-global-settings/:tokenAddress', async (req, res) => {
    const { tokenAddress } = req.params;
    const globalSettings = botState.settings.globalSnipeSettings;

    try {
        const result = await snipeToken(tokenAddress, globalSettings);

        /*if (result.success) {
            // 🔥 BROADCAST AUTO-OPEN MESSAGE
            broadcastToClients({
                type: 'auto_open_token_page',
                data: {
                    tokenAddress,
                    tokenPageUrl: result.tokenPageUrl,
                    destination: botState.settings.tokenPageDestination,
                    reason: 'manual_secondary_snipe'
                }
            });
        }*/

        res.json({ success: true, result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Firebase management endpoints
app.get('/api/firebase/used-communities', async (req, res) => {
    try {
        const snapshot = await db.collection('usedCommunities').get();
        const communities = [];
        snapshot.forEach(doc => {
            communities.push({
                id: doc.id,
                ...doc.data()
            });
        });
        res.json({ communities });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Tweet management endpoints
app.get('/api/firebase/used-tweets', async (req, res) => {
    try {
        const snapshot = await db.collection('usedTweets').get();
        const tweets = [];
        snapshot.forEach(doc => {
            tweets.push({
                id: doc.id,
                ...doc.data()
            });
        });
        res.json({ tweets });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/firebase/used-tweets/:tweetId', async (req, res) => {
    try {
        const { tweetId } = req.params;
        await db.collection('usedTweets').doc(tweetId).delete();

        // Remove from cache
        tweetCache.tweets.delete(tweetId);
        await saveTweetCacheToFile();

        res.json({ success: true, message: `Tweet ${tweetId} removed from Firebase` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/firebase/used-tweets', async (req, res) => {
    try {
        const snapshot = await db.collection('usedTweets').get();
        const batch = db.batch();
        snapshot.docs.forEach(doc => {
            batch.delete(doc.ref);
        });
        await batch.commit();

        // Clear cache
        tweetCache.tweets.clear();
        await saveTweetCacheToFile();

        res.json({ success: true, message: 'All used tweets cleared from Firebase' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Add these endpoints after the existing API routes

// Get all uploaded sound files
app.get('/api/sound-files', async (req, res) => {
    try {
        await ensureSoundsDir();

        // ✅ LOAD METADATA FILE
        const metadataPath = path.join(SOUNDS_DIR, 'metadata.json');
        let metadata = {};

        try {
            const metadataContent = await fsPromises.readFile(metadataPath, 'utf8');
            metadata = JSON.parse(metadataContent);
        } catch (error) {
            console.log('No metadata file found, will use generated names');
        }

        const files = await fsPromises.readdir(SOUNDS_DIR);
        const soundFiles = [];

        for (const filename of files) {
            // Skip metadata file
            if (filename === 'metadata.json') continue;

            try {
                const filePath = path.join(SOUNDS_DIR, filename);
                const stats = await fsPromises.stat(filePath);

                soundFiles.push({
                    filename,
                    originalName: metadata[filename]?.originalName || filename, // ✅ USE STORED ORIGINAL NAME
                    size: stats.size,
                    uploadedAt: metadata[filename]?.uploadedAt || stats.birthtime,
                    mimetype: metadata[filename]?.mimetype || getMimeType(path.extname(filename))
                });
            } catch (error) {
                console.error(`Error getting stats for ${filename}:`, error);
            }
        }

        res.json({
            success: true,
            files: soundFiles.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
        });
    } catch (error) {
        console.error('Error fetching sound files:', error);
        res.status(500).json({ error: error.message });
    }
});

// Upload a new sound file
app.post('/api/upload-sound', uploadSound.single('soundFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No sound file provided' });
        }

        const soundFile = {
            filename: req.file.filename,
            originalName: req.file.originalname, // ✅ This preserves the original name
            size: req.file.size,
            mimetype: req.file.mimetype,
            uploadedAt: new Date(),
            path: req.file.path
        };

        // ✅ SAVE ORIGINAL NAME TO A JSON FILE FOR RETRIEVAL
        const metadataPath = path.join(SOUNDS_DIR, 'metadata.json');
        let metadata = {};

        try {
            const existingData = await fsPromises.readFile(metadataPath, 'utf8');
            metadata = JSON.parse(existingData);
        } catch (error) {
            // File doesn't exist yet, start with empty object
        }

        metadata[req.file.filename] = {
            originalName: req.file.originalname,
            uploadedAt: new Date().toISOString(),
            size: req.file.size,
            mimetype: req.file.mimetype
        };

        await fsPromises.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

        console.log('🔊 Sound file uploaded:', soundFile);

        res.json({
            success: true,
            message: 'Sound file uploaded successfully',
            filename: soundFile.filename,
            originalName: soundFile.originalName,
            size: soundFile.size
        });
    } catch (error) {
        console.error('Error uploading sound file:', error);
        res.status(500).json({ error: error.message });
    }
});

// ADD THIS NEW ENDPOINT after line ~1850:
app.post('/api/clean-admin-lists', async (req, res) => {
    try {
        console.log('🧹 Cleaning admin list entries...');

        // Clean primary admins
        for (const [id, config] of botState.primaryAdminList.entries()) {
            if (config.address) {
                const cleanAddress = config.address.trim();
                if (cleanAddress !== config.address) {
                    console.log(`Cleaning primary admin: "${config.address}" -> "${cleanAddress}"`);
                    config.address = cleanAddress;

                    // Update in Firebase
                    await saveAdminListToFirebase('primary_admins', config);
                }
            }
        }

        // Clean secondary admins
        for (const [id, config] of botState.secondaryAdminList.entries()) {
            if (config.address) {
                const cleanAddress = config.address.trim();
                if (cleanAddress !== config.address) {
                    console.log(`Cleaning secondary admin: "${config.address}" -> "${cleanAddress}"`);
                    config.address = cleanAddress;

                    // Update in Firebase
                    await saveAdminListToFirebase('secondary_admins', config);
                }
            }
        }

        res.json({
            success: true,
            message: 'Admin lists cleaned successfully'
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete a sound file
app.delete('/api/sound-files/:filename', async (req, res) => {
    try {
        const { filename } = req.params;
        const filePath = path.join(SOUNDS_DIR, filename);

        try {
            await fsPromises.access(filePath);
            await fsPromises.unlink(filePath);

            // ✅ CLEAN UP METADATA
            const metadataPath = path.join(SOUNDS_DIR, 'metadata.json');
            try {
                const metadataContent = await fsPromises.readFile(metadataPath, 'utf8');
                const metadata = JSON.parse(metadataContent);
                delete metadata[filename];
                await fsPromises.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
            } catch (error) {
                console.log('No metadata to clean up');
            }

            console.log('🗑️ Sound file deleted:', filename);

            res.json({
                success: true,
                message: 'Sound file deleted successfully'
            });
        } catch (error) {
            if (error.code === 'ENOENT') {
                return res.status(404).json({ error: 'Sound file not found' });
            }
            throw error;
        }
    } catch (error) {
        console.error('Error deleting sound file:', error);
        res.status(500).json({ error: error.message });
    }
});

// Serve uploaded sound files
app.get('/api/sounds/:filename', (req, res) => {
    const { filename } = req.params;
    const filePath = path.join(SOUNDS_DIR, filename);

    res.sendFile(filePath, (error) => {
        if (error) {
            console.error('Error serving sound file:', error);
            res.status(404).json({ error: 'Sound file not found' });
        }
    });
});

app.delete('/api/firebase/used-communities/:communityId', async (req, res) => {
    try {
        const { communityId } = req.params;
        await db.collection('usedCommunities').doc(communityId).delete();
        res.json({ success: true, message: `Community ${communityId} removed from Firebase` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/firebase/used-communities', async (req, res) => {
    try {
        const snapshot = await db.collection('usedCommunities').get();
        const batch = db.batch();
        snapshot.docs.forEach(doc => {
            batch.delete(doc.ref);
        });
        await batch.commit();
        res.json({ success: true, message: 'All used communities cleared from Firebase' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Enhanced Firebase admin list endpoints
app.get('/api/firebase/admin-lists', async (req, res) => {
    try {
        const primaryAdmins = await loadAdminListFromFirebase('primary_admins');
        const secondaryAdmins = await loadAdminListFromFirebase('secondary_admins');

        res.json({
            success: true,
            data: {
                primary_admins: primaryAdmins,
                secondary_admins: secondaryAdmins
            },
            stats: {
                primaryCount: primaryAdmins.length,
                secondaryCount: secondaryAdmins.length
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/firebase/sync-admin-lists', async (req, res) => {
    try {
        const success = await botState.loadAdminListsFromFirebase();

        if (success) {
            // Broadcast sync update to all clients
            broadcastToClients({
                type: 'admin_lists_synced',
                data: {
                    stats: botState.getStats(),
                    timestamp: new Date().toISOString()
                }
            });

            res.json({
                success: true,
                message: 'Admin lists synchronized from Firebase',
                stats: botState.getStats()
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to sync admin lists from Firebase'
            });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/firebase/admin-lists/:listType', async (req, res) => {
    try {
        const { listType } = req.params;

        // Get all documents in the collection
        const snapshot = await db.collection(listType).get();

        // Delete all documents
        const batch = db.batch();
        snapshot.docs.forEach(doc => {
            batch.delete(doc.ref);
        });
        await batch.commit();

        // Clear local state
        switch (listType) {
            case 'primary_admins':
                botState.primaryAdminList.clear();
                break;
            case 'secondary_admins':
                botState.secondaryAdminList.clear();
                break;
        }

        // Broadcast update
        broadcastToClients({
            type: 'admin_list_cleared',
            data: {
                listType,
                stats: botState.getStats(),
                timestamp: new Date().toISOString()
            }
        });

        res.json({
            success: true,
            message: `All ${listType} cleared from Firebase and local state`,
            clearedCount: snapshot.docs.length,
            stats: botState.getStats()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Test Firebase connection endpoint
app.get('/api/test-firebase', async (req, res) => {
    try {
        const testDoc = await db.collection('test').add({
            message: 'Firebase connected successfully!',
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({
            success: true,
            message: 'Firebase connected!',
            docId: testDoc.id
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// WebSocket connections to platforms
function connectToPumpPortal() {
    // This now handles BOTH Pump.fun and Let's Bonk
    if (blockchainListener) {
        blockchainListener.stop();
    }

    console.log('🔌 Starting dual blockchain listener (Pump.fun + Let\'s Bonk)...');

    blockchainListener = new BlockchainTokenListener((tokenData, platform) => {
        if (!botState.isRunning) return;

        tokenData.masterStartTime = Date.now();
        processTokenInstantly(tokenData, platform);
    });

    blockchainListener.start();

    broadcastToClients({
        type: 'platform_status',
        data: {
            platform: 'both',
            status: 'connected',
            source: 'blockchain_direct',
            message: 'Direct blockchain: Pump.fun + Let\'s Bonk'
        }
    });
}

function connectToLetsBonk() {
    // This is now a no-op - the dual listener handles it
    console.log('ℹ️ Let\'s Bonk is handled by dual blockchain listener');
}

app.get('/api/thread-stats', (req, res) => {
    res.json({
        activeThreads: activeThreadCount,
        maxThreads: MAX_CONCURRENT_THREADS,
        utilizationPercent: Math.round((activeThreadCount / MAX_CONCURRENT_THREADS) * 100)
    });
});

// Main API Routes
app.get('/api/status', (req, res) => {
    res.json({
        isRunning: botState.isRunning,
        settings: botState.settings,
        stats: botState.getStats()
    });
});

app.post('/api/start', (req, res) => {
    if (botState.isRunning) {
        return res.status(400).json({ error: 'Bot is already running' });
    }

    if (!botState.settings.privateKey) {
        return res.status(400).json({ error: 'Private key not set' });
    }

    botState.isRunning = true;
    connectToPumpPortal();
    connectToLetsBonk();

    broadcastToClients({
        type: 'bot_status',
        data: { isRunning: true }
    });

    res.json({ success: true, message: 'Bot started' });
});

app.post('/api/stop', (req, res) => {
    botState.isRunning = false;

    if (blockchainListener) {
        blockchainListener.stop();
        blockchainListener = null;
    }

    if (botState.letsBonkSocket) {
        botState.letsBonkSocket.close();
    }

    botState.reconnectTimeouts.forEach(timeout => clearTimeout(timeout));
    botState.reconnectTimeouts.clear();

    broadcastToClients({
        type: 'bot_status',
        data: { isRunning: false }
    });

    res.json({ success: true, message: 'Bot stopped' });
});

app.post('/api/settings', (req, res) => {
    const { privateKey, tokenPageDestination } = req.body;

    if (privateKey) {
        try {
            Keypair.fromSecretKey(bs58.decode(privateKey));
            botState.settings.privateKey = privateKey;
        } catch (error) {
            return res.status(400).json({ error: 'Invalid private key' });
        }
    }

    if (tokenPageDestination) {
        botState.settings.tokenPageDestination = tokenPageDestination;
    }

    res.json({ success: true, settings: botState.settings });
});

// Updated filter settings endpoint with consolidated admin filtering
app.post('/api/filter-settings', (req, res) => {
    const {
        enableAdminFilter,
        enableCommunityReuse,
        snipeAllTokens,
        detectionOnlyMode,
        bonkTokensOnly  // Add new filter for bonk tokens only
    } = req.body;

    console.log('🔧 Received filter settings update:', {
        enableAdminFilter,
        enableCommunityReuse,
        snipeAllTokens,
        detectionOnlyMode,
        bonkTokensOnly
    });

    // Update admin filtering (now handles both Twitter admins AND wallet addresses)
    if (typeof enableAdminFilter !== 'undefined') {
        botState.settings.enableAdminFilter = enableAdminFilter;
        console.log(`📋 Admin filtering (Twitter + Wallets): ${enableAdminFilter ? 'ENABLED' : 'DISABLED'}`);
    }

    // Update community reuse prevention
    if (typeof enableCommunityReuse !== 'undefined') {
        botState.settings.enableCommunityReuse = enableCommunityReuse;
        console.log(`😍 Community reuse prevention: ${enableCommunityReuse ? 'ENABLED' : 'DISABLED'}`);
    }

    // Update snipe all tokens mode
    if (typeof snipeAllTokens !== 'undefined') {
        botState.settings.snipeAllTokens = snipeAllTokens;
        console.log(`⚡ Snipe all tokens: ${snipeAllTokens ? 'ENABLED' : 'DISABLED'}`);

        if (snipeAllTokens) {
            console.log('⚠️ WARNING: SNIPE ALL TOKENS MODE ENABLED - This will attempt to snipe EVERY new token!');
        }
    }

    // Update detection only mode
    if (typeof detectionOnlyMode !== 'undefined') {
        botState.settings.detectionOnlyMode = detectionOnlyMode;
        console.log(`🛡️ Detection only mode: ${detectionOnlyMode ? 'ENABLED' : 'DISABLED'}`);

        if (!detectionOnlyMode && snipeAllTokens) {
            console.log('🚨 CRITICAL WARNING: Detection only mode is OFF and Snipe all tokens is ON!');
        }
    }

    // Update bonk tokens only filter
    if (typeof bonkTokensOnly !== 'undefined') {
        botState.settings.bonkTokensOnly = bonkTokensOnly;
        console.log(`🦎 Bonk tokens only: ${bonkTokensOnly ? 'ENABLED' : 'DISABLED'}`);
    }

    // Log current filter configuration
    console.log('📊 Current filter configuration:', {
        enableAdminFilter: botState.settings.enableAdminFilter,
        enableCommunityReuse: botState.settings.enableCommunityReuse,
        snipeAllTokens: botState.settings.snipeAllTokens,
        detectionOnlyMode: botState.settings.detectionOnlyMode,
        bonkTokensOnly: botState.settings.bonkTokensOnly
    });

    // Update filter logic explanation based on current settings
    let filterExplanation = '';
    if (botState.settings.bonkTokensOnly) {
        filterExplanation = 'Will only process Bonk tokens (all Pump.fun tokens filtered out)';
    } else if (botState.settings.snipeAllTokens) {
        filterExplanation = 'Will detect and snipe ALL new tokens (all other filters bypassed)';
    } else if (botState.settings.enableAdminFilter) {
        filterExplanation = 'Will detect tokens from wallet addresses or Twitter admins in your Primary/Secondary Admin lists';
    } else {
        filterExplanation = 'Will detect ALL tokens (no filtering applied)';
    }

    console.log(`🎯 Filter behavior: ${filterExplanation}`);

    // Return updated settings
    res.json({
        success: true,
        settings: {
            enableAdminFilter: botState.settings.enableAdminFilter,
            enableCommunityReuse: botState.settings.enableCommunityReuse,
            snipeAllTokens: botState.settings.snipeAllTokens,
            detectionOnlyMode: botState.settings.detectionOnlyMode,
            bonkTokensOnly: botState.settings.bonkTokensOnly
        },
        message: 'Filter settings updated successfully',
        explanation: filterExplanation,
        warnings: [
            ...(botState.settings.bonkTokensOnly ? ['🦎 Bonk Tokens Only mode is ACTIVE - all Pump.fun tokens will be filtered out'] : []),
            ...(botState.settings.snipeAllTokens ? ['⚠️ Snipe All Tokens mode is ACTIVE'] : []),
            ...(!botState.settings.detectionOnlyMode ? ['⚠️ Detection Only mode is OFF - real sniping enabled'] : []),
            ...(botState.settings.snipeAllTokens && !botState.settings.detectionOnlyMode ? ['🚨 DANGER: Will snipe ALL tokens automatically!'] : [])
        ]
    });
});

// Enhanced list management routes with Firebase integration
app.get('/api/lists/:listType', async (req, res) => {
    try {
        const { listType } = req.params;

        // Ensure Firebase data is loaded
        if (!botState.isFirebaseLoaded) {
            await botState.loadAdminListsFromFirebase();
        }

        const list = botState.getList(listType);
        res.json({
            list,
            firebaseLoaded: botState.isFirebaseLoaded,
            count: list.length
        });
    } catch (error) {
        console.error('Error fetching list:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/lists/:listType', async (req, res) => {
    try {
        const { listType } = req.params;
        const entry = req.body;

        if (!entry.address && !entry.username) {
            return res.status(400).json({ error: 'Address or username required' });
        }
        if (!entry.amount || !entry.fees) {
            return res.status(400).json({ error: 'Amount and fees required' });
        }

        const config = await botState.addToList(listType, entry);

        // Broadcast update to all connected clients
        broadcastToClients({
            type: 'admin_list_updated',
            data: {
                listType,
                action: 'added',
                entry: config,
                stats: botState.getStats(),
                timestamp: new Date().toISOString()
            }
        });

        res.json({
            success: true,
            config,
            message: `Entry added to ${listType} and saved to Firebase`,
            stats: botState.getStats()
        });
    } catch (error) {
        console.error('Error adding to list:', error);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/lists/:listType/:id', async (req, res) => {
    try {
        const { listType, id } = req.params;
        const success = await botState.removeFromList(listType, id);

        if (success) {
            // Broadcast update to all connected clients
            broadcastToClients({
                type: 'admin_list_updated',
                data: {
                    listType,
                    action: 'removed',
                    entryId: id,
                    stats: botState.getStats(),
                    timestamp: new Date().toISOString()
                }
            });

            res.json({
                success: true,
                message: `Entry removed from ${listType} and Firebase`,
                stats: botState.getStats()
            });
        } else {
            res.status(404).json({ error: 'Entry not found' });
        }
    } catch (error) {
        console.error('Error removing from list:', error);
        res.status(500).json({ error: error.message });
    }
});

// Detected tokens routes
app.get('/api/detected-tokens', (req, res) => {
    const tokens = botState.getDetectedTokens();
    res.json({ tokens });
});

app.delete('/api/detected-tokens', (req, res) => {
    botState.clearDetectedTokens();
    res.json({ success: true, message: 'Detected tokens cleared' });
});

app.post('/api/detected-tokens/:tokenAddress/snipe', async (req, res) => {
    const { tokenAddress } = req.params;

    if (!botState.detectedTokens.has(tokenAddress)) {
        return res.status(404).json({ error: 'Token not found in detected list' });
    }

    const tokenData = botState.detectedTokens.get(tokenAddress);

    if (!tokenData.config) {
        return res.status(400).json({ error: 'No snipe configuration available for this token' });
    }

    try {
        const result = await snipeToken(tokenAddress, tokenData.config);
        res.json({ success: true, result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== DEMO SYSTEM ==========

// Helper functions for demo system
function generateDemoTokenData(template, customWallet = null, customTwitter = null) {
    const randomWallet = customWallet || DEMO_WALLETS[Math.floor(Math.random() * DEMO_WALLETS.length)];
    //const randomTokenAddress = generateRandomTokenAddress();
    const randomTokenAddress = "2XrRP8wWBjNPcVZriGQpXTWg11si1tVSrzpMJzFspump";
    const randomSignature = generateRandomSignature();
    const randomTwitter = customTwitter || template.twitterHandle;

    const baseData = {
        signature: randomSignature,
        mint: randomTokenAddress,
        traderPublicKey: randomWallet,
        creator: randomWallet,
        txType: "create",
        name: template.name,
        symbol: template.symbol,
        uri: template.uri,
        pool: template.pool,
        solAmount: Math.random() * 5 + 0.000052,
        marketCapSol: Math.random() * 50 + 10,
        initialBuy: Math.random() * 100000000,
    };

    if (template.platform === "pumpfun") {
        return {
            ...baseData,
            bondingCurveKey: generateRandomTokenAddress(),
            vTokensInBondingCurve: Math.random() * 1000000000 + 100000000,
            vSolInBondingCurve: Math.random() * 30 + 5,
            metadata: {
                name: template.name,
                symbol: template.symbol,
                twitter: `https://twitter.com/${randomTwitter}`
            }
        };
    } else {
        return {
            ...baseData,
            solInPool: Math.random() * 10 + 1,
            tokensInPool: Math.random() * 1000000000 + 100000000,
            newTokenBalance: Math.random() * 100000000,
            metadata: {
                name: template.name,
                symbol: template.symbol,
                twitter: `https://twitter.com/${randomTwitter}`
            }
        };
    }
}


function generateRandomTokenAddress() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz123456789';
    let result = '';
    for (let i = 0; i < 44; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function generateRandomSignature() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz123456789';
    let result = '';
    for (let i = 0; i < 88; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

app.post('/api/demo/inject-token', (req, res) => {
    const {
        templateIndex = 0,
        customWallet = null,
        customTwitter = null,
        customCommunity = null,
        customTweet = null,
        platform = null
    } = req.body;

    let template = DEMO_TOKEN_TEMPLATES[templateIndex];
    if (!template) {
        template = DEMO_TOKEN_TEMPLATES[0];
    }

    if (platform) {
        template = { ...template, platform, pool: platform === 'pumpfun' ? 'pump' : 'bonk' };
    }

    // Generate the demo token data
    const demoTokenData = generateDemoTokenData(template, customWallet, template.twitterHandle);

    // Make sure metadata is properly set
    if (!demoTokenData.metadata) {
        demoTokenData.metadata = {};
    }

    // FIXED: Check customTweet FIRST, then other options
    // This ensures tweet URLs take priority over everything else
    if (customTweet) {
        demoTokenData.metadata.twitter = customTweet;
        console.log(`🐦 Custom tweet URL set: ${customTweet}`);
    } else if (customCommunity) {
        demoTokenData.metadata.twitter = `https://x.com/i/communities/${customCommunity}`;
        console.log(`👥 Custom community set: ${customCommunity}`);
    } else if (customTwitter) {
        demoTokenData.metadata.twitter = `https://twitter.com/${customTwitter}`;
        console.log(`👤 Custom Twitter handle set: ${customTwitter}`);
    } else if (template.twitterHandle) {
        demoTokenData.metadata.twitter = `https://twitter.com/${template.twitterHandle}`;
        console.log(`📋 Template Twitter handle used: ${template.twitterHandle}`);
    }

    // Ensure name and symbol are in metadata
    demoTokenData.metadata.name = demoTokenData.name || template.name;
    demoTokenData.metadata.symbol = demoTokenData.symbol || template.symbol;

    console.log(`🧪 DEMO: Injecting token data for ${template.platform}:`, {
        tokenAddress: demoTokenData.mint,
        name: demoTokenData.metadata.name,
        symbol: demoTokenData.metadata.symbol,
        twitter: demoTokenData.metadata.twitter,
        customTweet: customTweet || 'none',
        customCommunity: customCommunity || 'none',
        customTwitter: customTwitter || 'none'
    });

    processNewToken(demoTokenData, template.platform);

    res.json({
        success: true,
        message: 'Demo token injected',
        tokenData: demoTokenData
    });
});

// Add this to your demo endpoints
app.post('/api/demo/inject-bonk-token', (req, res) => {
    const demoTokenData = {
        signature: 'demo-signature',
        mint: '2g32h8SRweRF4BJAKmBkUhu17QLxYhBo39DYNxgWbonk',
        traderPublicKey: 'demo-wallet',
        creator: 'demo-wallet',
        txType: "create",
        name: 'Demo Bonk Token',
        symbol: 'DEMO',
        pool: 'bonk', // This is key!
        solAmount: 1.5,
        marketCapSol: 25.0
    };

    console.log('🧪 DEMO: Injecting BONK token for testing GeckoTerminal integration');
    processNewToken(demoTokenData, 'letsbonk');

    res.json({
        success: true,
        message: 'Demo bonk token injected'
    });
});

app.post('/api/test-amount-conversion', (req, res) => {
    const testAmount = 0.00099;
    const LAMPORTS_PER_SOL = 1000000000;

    const lamports = Math.floor(testAmount * LAMPORTS_PER_SOL);
    const backToSOL = lamports / LAMPORTS_PER_SOL;

    res.json({
        input: testAmount,
        convertedLamports: lamports,
        expectedLamports: 990000,
        matches: lamports === 990000,
        backToSOL: backToSOL,
        diagnosis: lamports === 990000 ?
            '✅ Conversion working correctly' :
            `❌ Conversion issue! Got ${lamports} instead of 990000`
    });
});


app.post('/api/demo/inject-batch', (req, res) => {
    if (!botState.isRunning) {
        return res.status(400).json({ error: 'Bot must be running to inject demo tokens' });
    }

    const { count = 5, delay = 2000 } = req.body;
    let injected = 0;

    const injectNext = () => {
        if (injected >= count) {
            return;
        }

        const templateIndex = Math.floor(Math.random() * DEMO_TOKEN_TEMPLATES.length);
        const template = DEMO_TOKEN_TEMPLATES[templateIndex];
        const demoTokenData = generateDemoTokenData(template);

        console.log(`🧪 DEMO BATCH ${injected + 1}/${count}: Injecting ${template.name}`);
        processNewToken(demoTokenData, template.platform);

        injected++;

        if (injected < count) {
            setTimeout(injectNext, delay);
        }
    };

    injectNext();

    res.json({
        success: true,
        message: `Injecting ${count} demo tokens with ${delay}ms delay`
    });
});

app.get('/api/demo/templates', (req, res) => {
    res.json({
        templates: DEMO_TOKEN_TEMPLATES.map((template, index) => ({
            index,
            name: template.name,
            symbol: template.symbol,
            platform: template.platform,
            twitterHandle: template.twitterHandle
        })),
        wallets: DEMO_WALLETS
    });
});

app.post('/api/demo/inject-from-list', (req, res) => {
    if (!botState.isRunning) {
        return res.status(400).json({ error: 'Bot must be running to inject demo tokens' });
    }

    const { listType, templateIndex = 0 } = req.body;

    let targetWallet = null;
    let targetTwitter = null;

    const list = botState.getList(listType);
    if (list.length === 0) {
        return res.status(400).json({ error: `No entries in ${listType} list` });
    }

    const randomEntry = list[Math.floor(Math.random() * list.length)];

    if (listType.includes('wallets')) {
        targetWallet = randomEntry.address;
    } else {
        targetTwitter = randomEntry.address;
    }

    const template = DEMO_TOKEN_TEMPLATES[templateIndex] || DEMO_TOKEN_TEMPLATES[0];
    const demoTokenData = generateDemoTokenData(template, targetWallet, targetTwitter);

    console.log(`🧪 DEMO FROM LIST: Injecting token with ${listType} entry:`, {
        wallet: targetWallet,
        twitter: targetTwitter,
        tokenName: template.name
    });

    processNewToken(demoTokenData, template.platform);

    res.json({
        success: true,
        message: `Demo token injected using ${listType} entry`,
        usedEntry: randomEntry,
        tokenData: demoTokenData
    });
});

// ADD THESE NEW API ENDPOINTS
app.post('/api/scrape-community/:communityId', async (req, res) => {
    try {
        const { communityId } = req.params;

        if (!twitterScraper.isInitialized) {
            const initSuccess = await twitterScraper.init();
            if (!initSuccess) {
                return res.status(500).json({ error: 'Failed to initialize Twitter scraper' });
            }
        }

        const loginSuccess = await twitterScraper.automaticLogin();
        if (!loginSuccess) {
            return res.status(500).json({ error: 'Failed to login to Twitter' });
        }

        const communityAdmins = await twitterScraper.scrapeCommunityAdmins(communityId);

        res.json({
            success: true,
            communityId: communityId,
            admins: communityAdmins,
            totalAdmins: communityAdmins.length,
            scrapedAt: new Date().toISOString()
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/twitter-scraper-status', (req, res) => {
    res.json({
        initialized: twitterScraper.isInitialized,
        sessionActive: twitterScraper.sessionActive,
        credentialsConfigured: !!(TWITTER_CONFIG.username && TWITTER_CONFIG.password)
    });
});

app.get('/api/twitter-session-status', async (req, res) => {
    try {
        if (!twitterScraper.isInitialized) {
            return res.json({
                initialized: false,
                loggedIn: false,
                message: 'Twitter scraper not initialized'
            });
        }

        // Force a fresh status check
        const sessionStatus = await twitterScraper.checkSessionStatus();

        // If URL shows we're on home page, override to logged in
        if (sessionStatus.url && sessionStatus.url.includes('/home')) {
            sessionStatus.loggedIn = true;
            twitterScraper.sessionActive = true;
        }

        res.json({
            initialized: twitterScraper.isInitialized,
            loggedIn: sessionStatus.loggedIn,
            url: sessionStatus.url,
            error: sessionStatus.error,
            message: sessionStatus.loggedIn ? 'Session active' : 'Please login manually'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/test-geckoterminal-enhanced/:tokenAddress', async (req, res) => {
    try {
        const { tokenAddress } = req.params;

        console.log(`🧪 Testing enhanced GeckoTerminal API for: ${tokenAddress}`);

        const geckoResponse = await geckoTerminalAPI.fetchTokenInfo(tokenAddress);
        const enhancedData = geckoTerminalAPI.extractEnhancedTokenData(geckoResponse);

        res.json({
            success: true,
            tokenAddress,
            rawResponse: geckoResponse,
            enhancedData,
            hasData: !!enhancedData,
            extractedFields: {
                name: enhancedData?.name,
                symbol: enhancedData?.symbol,
                image_url: enhancedData?.image_url,
                twitter_handle: enhancedData?.twitterHandle,
                holders_count: enhancedData?.holdersCount,
                gt_score: enhancedData?.gtScore,
                is_honeypot: enhancedData?.isHoneypot
            }
        });
    } catch (error) {
        console.error('❌ GeckoTerminal test failed:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            tokenAddress: req.params.tokenAddress
        });
    }
});

app.post('/api/twitter-open-login', async (req, res) => {
    try {
        if (!twitterScraper.isInitialized) {
            const initSuccess = await twitterScraper.init();
            if (!initSuccess) {
                return res.status(500).json({ error: 'Failed to initialize Twitter scraper' });
            }
        }

        // Use automatic login with credentials from environment
        console.log('🔐 Attempting automatic Twitter login...');
        const loginSuccess = await twitterScraper.automaticLogin();

        if (loginSuccess) {
            console.log('✅ Automatic Twitter login successful');
            res.json({
                success: true,
                message: 'Successfully logged in to Twitter automatically'
            });
        } else {
            console.log('❌ Automatic login failed');
            res.status(500).json({ error: 'Failed to login automatically. Check credentials in .env file' });
        }

    } catch (error) {
        console.error('❌ Login error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ========== WEBSOCKET CONNECTION HANDLING ==========

wss.on('connection', (ws) => {
    console.log('Client connected to WebSocket');
    wsClients.add(ws);

    ws.send(JSON.stringify({
        type: 'bot_status',
        data: { isRunning: botState.isRunning }
    }));

    ws.on('close', () => {
        console.log('Client disconnected from WebSocket');
        wsClients.delete(ws);
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        wsClients.delete(ws);
    });
});

// ========== FIREBASE INITIALIZATION ==========

async function initializeFirebaseData() {
    console.log('🔥 Initializing Firebase data...');

    try {
        await testFirebase();
        await botState.loadAdminListsFromFirebase();

        console.log('✅ Firebase initialization complete');
        console.log(`📊 Loaded admin lists:`, botState.getStats());
    } catch (error) {
        console.error('❌ Firebase initialization failed:', error);
    }
}


// ========== ERROR HANDLING ==========

app.use((error, req, res, next) => {
    console.error('Express error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// ========== SERVER STARTUP ==========

httpServer.listen(PORT, async () => {
    console.log(`🚀 DevScope backend running on port ${PORT}`);
    console.log(`WebSocket endpoint: wss://localhost:${PORT}`);
    console.log(`HTTP API endpoint: http://localhost:${PORT}/api`);

    const loadResult = await botState.loadAdminListsFromFirebase();

    if (loadResult.success) {
        console.log(`✅ Admin lists loaded from ${loadResult.source}`);
        console.log(`   Primary: ${loadResult.primaryCount} entries`);
        console.log(`   Secondary: ${loadResult.secondaryCount} entries`);

        if (loadResult.warning) {
            console.log(`⚠️ ${loadResult.warning}`);
        }
    } else {
        console.error(`❌ Failed to load admin lists: ${loadResult.error}`);
    }

    // Log server startup
    logger.info(`=== SERVER STARTED ===`);
    logger.info(`Port: ${PORT}`);
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info(`Timestamp: ${new Date().toISOString()}`);

    // Initialize Firebase data
    await initializeFirebaseData();
    await initializeCommunityCache();
    await initializeTweetCache();
    await ensureSoundsDir();
    initializeTimingLog();
    initializeSecondaryMatchesLog();
    initializePrimaryMatchesLog();

    console.log('🔥 Enhanced Firebase Admin Lists Integration Loaded');
    console.log('🔊 Sound upload system initialized');
    console.log('✅ Features:');
    console.log('  - Firebase storage for Primary/Secondary admin lists');
    console.log('  - Real-time sync between local state and Firebase');
    console.log('  - Automatic data loading on server startup');
    console.log('  - Enhanced statistics with Firebase status');
    console.log('  - Individual Twitter account detection');
    console.log('  - Twitter community detection and tracking');
    console.log('  - Enhanced token page opening on snipe');
    console.log('  - Improved speed optimizations');

    console.log('🧪 Available Firebase endpoints:');
    console.log('  GET /api/firebase/admin-lists - Get all admin lists from Firebase');
    console.log('  POST /api/firebase/sync-admin-lists - Sync admin lists from Firebase');
    console.log('  DELETE /api/firebase/admin-lists/:listType - Clear specific admin list');
    console.log('  GET /api/firebase/used-communities - Fetch used communities');
    console.log('  DELETE /api/firebase/used-communities - Clear all used communities');
    console.log('  GET /api/test-firebase - Test Firebase connection');

    console.log('🎯 Demo data injection system loaded');
    console.log('Available demo endpoints:');
    console.log('  POST /api/demo/inject-token - Inject single demo token');
    console.log('  POST /api/demo/inject-batch - Inject multiple demo tokens');
    console.log('  POST /api/demo/inject-from-list - Inject token matching your lists');
    console.log('  GET /api/demo/templates - Get available demo templates');

    // ✅ INITIALIZE TIMING TRACKER
    console.log('⏱️ Comprehensive timing tracker initialized');
    console.log(`📊 Timing breakdown log: ${timingTracker.logFile}`);

    console.log('🔥 Enhanced Firebase Admin Lists Integration Loaded');
    console.log('🔊 Sound upload system initialized');
    console.log('✅ Features:');
    console.log('  - Firebase storage for Primary/Secondary admin lists');
    console.log('  - Real-time sync between local state and Firebase');
    console.log('  - Automatic data loading on server startup');
    console.log('  - Enhanced statistics with Firebase status');
    console.log('  - Individual Twitter account detection');
    console.log('  - Twitter community detection and tracking');
    console.log('  - Enhanced token page opening on snipe');
    console.log('  - Improved speed optimizations');
    console.log('  - ⏱️ COMPREHENSIVE TIMING TRACKING')

});

process.on('SIGINT', async () => {
    console.log('\n⏹️ Shutting down gracefully...');

    // Log shutdown
    logger.info('Server shutting down gracefully');

    if (twitterScraper) {
        await twitterScraper.close();
    }

    // Close Winston logger
    logger.end();

    process.exit(0);
});

function cleanupScrapingCache() {
    const now = Date.now();
    const expiredCommunities = [];

    for (const [communityId, cachedData] of scrapingResults.entries()) {
        if (now - cachedData.timestamp > SCRAPING_RESULT_CACHE_TIME) {
            expiredCommunities.push(communityId);
        }
    }

    expiredCommunities.forEach(communityId => {
        scrapingResults.delete(communityId);
        console.log(`🧹 Cleaned up expired cache for community ${communityId}`);
    });
}

// ✅ ADD AUTOMATIC CLEANUP EVERY 60 SECONDS
setInterval(cleanupScrapingCache, 60000);

// ========== DEBUGGING FUNCTIONS ==========
function getScrapingStats() {
    return {
        activeSessions: activeScrapingSessions.size,
        cachedResults: scrapingResults.size,
        activeSessionCommunities: Array.from(activeScrapingSessions.keys()),
        cachedCommunities: Array.from(scrapingResults.keys())
    };
}

// Log scraping stats every 30 seconds for debugging
setInterval(() => {
    const stats = getScrapingStats();
    if (stats.activeSessions > 0 || stats.cachedResults > 0) {
        console.log('📊 Scraping Stats:', stats);
    }
}, 30000);

const HTTPS_PORT = process.env.HTTPS_PORT || 3002;

httpsServer.listen(HTTPS_PORT, () => {
    console.log(`🔒 HTTPS Server with WebSocket running on port ${HTTPS_PORT}`);
    console.log(`🔌 WebSocket endpoint: wss://devscope.fun:${HTTPS_PORT}`);
});

module.exports = { app, httpServer, botState, TwitterAPI, twitterAPI, scrapeCommunityAndMatchAdmins, fetchIPFSFastest, processToken };
