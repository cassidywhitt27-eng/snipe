const { Connection, PublicKey } = require('@solana/web3.js');
const grpc = require('@triton-one/yellowstone-grpc');
const bs58 = require('bs58');
const dotenv = require("dotenv");

dotenv.config();

// Constants
const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const LETS_BONK_PROGRAM = new PublicKey('BonKktHZNPGvGFxNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

// gRPC Client Setup
const GRPC_ENDPOINT = "http://grpc.solanavibestation.com:10000";

class BlockchainTokenListener {
    constructor(onTokenCallback) {
        this.onTokenCallback = onTokenCallback;
        this.grpcClient = null;
        this.grpcStream = null;
        this.isGrpcConnected = false;
        this.reconnecting = false;
        this.isSubscribed = false; // ✅ NEW: Track subscription state
        this.reconnectAttempts = 0; // ✅ NEW: Track reconnection attempts
        this.maxReconnectAttempts = 10;
        this.pingInterval = null; // ✅ NEW: Store ping interval reference

        this.recentSignatures = new Map();
        this.recentMints = new Map();
        this.processingTokens = new Set();

        console.log('🚀 Blockchain listener initialized');
    }

    async start() {
        console.log('🔗 Starting blockchain listeners...');
        await this.initGrpcClient();
        await this.subscribeToGrpcUpdates();
        console.log('✅ Blockchain listeners started');
    }

    async initGrpcClient() {
        try {
            // ✅ ONLY create new client if one doesn't exist
            if (this.grpcClient) {
                console.log("⚠️ gRPC client already exists, reusing...");
                return true;
            }

            this.grpcClient = new grpc.default(
                GRPC_ENDPOINT,
                undefined
            );

            console.log("✅ gRPC client initialized");
            this.isGrpcConnected = true;
            this.reconnectAttempts = 0; // ✅ Reset on successful connection
            return true;
        } catch (error) {
            console.error("❌ Failed to initialize gRPC client:", error);
            this.isGrpcConnected = false;
            return false;
        }
    }

    async subscribeToGrpcUpdates() {
        // ✅ PREVENT MULTIPLE SUBSCRIPTIONS
        if (this.isSubscribed) {
            console.log("⚠️ Already subscribed, skipping...");
            return;
        }

        if (!this.grpcClient) {
            console.error("❌ gRPC client not initialized");
            return;
        }

        try {
            this.grpcStream = await this.grpcClient.subscribe();
            this.isSubscribed = true; // ✅ Mark as subscribed

            console.log("🔌 gRPC stream created");

            // ✅ IMPROVED: Handle incoming data
            this.grpcStream.on("data", (data) => {
                this.handleGrpcUpdate(data);
            });

            // ✅ IMPROVED: Better error handling
            this.grpcStream.on("error", (error) => {
                console.error("❌ gRPC stream error:", error.message);
                
                // ✅ Don't immediately reconnect on every error
                this.isGrpcConnected = false;
                this.isSubscribed = false;
                
                // ✅ Only reconnect if not already reconnecting
                if (!this.reconnecting && this.reconnectAttempts < this.maxReconnectAttempts) {
                    this.scheduleReconnect();
                } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                    console.error("❌ Max reconnection attempts reached. Manual restart required.");
                }
            });

            // ✅ IMPROVED: Handle stream end
            this.grpcStream.on("end", () => {
                console.log("⚠️ gRPC stream ended");
                this.isGrpcConnected = false;
                this.isSubscribed = false;
                
                if (!this.reconnecting && this.reconnectAttempts < this.maxReconnectAttempts) {
                    this.scheduleReconnect();
                }
            });

            // ✅ SEND SUBSCRIPTION REQUEST ONCE
            const request = {
                accounts: {},
                slots: {},
                transactions: {
                    "pumpFun": {
                        vote: false,
                        failed: false,
                        accountInclude: [PUMP_FUN_PROGRAM.toString()],
                        accountExclude: [],
                        accountRequired: []
                    },
                    "letsBonk": {
                        vote: false,
                        failed: false,
                        accountInclude: [LETS_BONK_PROGRAM.toString()],
                        accountExclude: [],
                        accountRequired: []
                    }
                },
                transactionsStatus: {},
                blocks: {},
                blocksMeta: {},
                entry: {},
                commitment: 1,
                accountsDataSlice: []
            };

            this.grpcStream.write(request);
            console.log("✅ gRPC subscription request sent for both pump.fun and letsbonk");

            // ✅ IMPROVED: Proper ping mechanism
            this.startPingInterval();

        } catch (error) {
            console.error("❌ Failed to subscribe to gRPC updates:", error);
            this.isGrpcConnected = false;
            this.isSubscribed = false;
            
            // ✅ Schedule reconnection on subscription failure
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.scheduleReconnect();
            }
        }
    }

    // ✅ NEW: Centralized reconnection scheduling
    scheduleReconnect() {
        if (this.reconnecting) {
            console.log("⏳ Reconnection already scheduled, skipping...");
            return;
        }

        this.reconnecting = true;
        this.reconnectAttempts++;
        
        // ✅ Exponential backoff: 5s, 10s, 20s, 40s, max 60s
        const delay = Math.min(5000 * Math.pow(2, this.reconnectAttempts - 1), 60000);
        
        console.log(`⏳ Scheduling reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`);

        setTimeout(async () => {
            this.reconnecting = false;
            
            // ✅ Clean up old stream if it exists
            if (this.grpcStream) {
                try {
                    this.grpcStream.end();
                } catch (e) {
                    // Ignore cleanup errors
                }
                this.grpcStream = null;
            }

            // ✅ Only recreate client if it's truly dead
            if (!this.grpcClient || !this.isGrpcConnected) {
                this.grpcClient = null; // Force recreation
                await this.initGrpcClient();
            }

            // ✅ Subscribe again
            if (this.isGrpcConnected) {
                await this.subscribeToGrpcUpdates();
            }
        }, delay);
    }

    // ✅ NEW: Proper ping interval management
    startPingInterval() {
        // ✅ Clear any existing interval
        this.stopPingInterval();

        // ✅ Send ping every 30 seconds to keep connection alive
        this.pingInterval = setInterval(() => {
            if (this.grpcStream && this.isGrpcConnected && this.isSubscribed) {
                try {
                    const pingRequest = {
                        ping: { id: Date.now() }
                    };
                    this.grpcStream.write(pingRequest);
                    console.log("📡 Ping sent to keep connection alive");
                } catch (error) {
                    console.error("❌ Failed to send ping:", error.message);
                    // Don't reconnect on ping failure - let error handler deal with it
                }
            }
        }, 30000);

        console.log("✅ Ping interval started (30s)");
    }

    // ✅ NEW: Stop ping interval
    stopPingInterval() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
            console.log("🛑 Ping interval stopped");
        }
    }

    handleGrpcUpdate(data) {
        try {
            if (data.transaction) {
                this.handleTransactionUpdate(data.transaction);
            } else if (data.slot) {
                // Handle slot updates if needed
            } else if (data.pong) {
                console.log("🏓 Received Pong response - connection alive");
            }
        } catch (error) {
            console.error("❌ Error handling gRPC update:", error);
        }
    }

    handleTransactionUpdate(transactionUpdate) {
        try {
            const transaction = transactionUpdate.transaction;
            let signature = transaction.signature;
            
            if (!signature) return;
            
            // Convert signature from Buffer to base58 string (Solana format)
            let signatureStr;
            if (Buffer.isBuffer(signature)) {
                signatureStr = bs58.encode(signature);
            } else if (typeof signature === 'string') {
                signatureStr = signature;
            } else {
                console.log('Unknown signature type:', typeof signature);
                return;
            }
            
            // Determine which program this transaction is for
            let platform = null;
            if (transaction.transaction && transaction.transaction.message) {
                const message = transaction.transaction.message;
                const accountKeys = message.accountKeys || [];
                
                // Convert accountKeys to strings for comparison
                const accountKeyStrings = accountKeys.map(key => {
                    if (typeof key === 'string') return key;
                    if (Buffer.isBuffer(key)) return new PublicKey(key).toString();
                    if (key.pubkey) return key.pubkey.toString();
                    return key.toString();
                });
                
                if (accountKeyStrings.includes(PUMP_FUN_PROGRAM.toString())) {
                    platform = 'pump.fun';
                } else if (accountKeyStrings.includes(LETS_BONK_PROGRAM.toString())) {
                    platform = 'letsbonk';
                }
            }
            
            if (platform) {
                console.log(`🟣 ${platform} transaction detected: ${signatureStr.substring(0, 12)}...`);
                
                // Create a logs-like object to maintain compatibility
                const logs = {
                    signature: signatureStr,
                    logs: transaction.meta?.logMessages || []
                };
                
                // Pass the full gRPC transaction data
                this.handleTokenCreation(logs, platform, transaction);
            }
        } catch (error) {
            console.error("❌ Error handling transaction update:", error);
        }
    }

    async handleTokenCreation(logs, platform, grpcTransaction) {
        const signature = logs.signature;

        if (this.recentSignatures.has(signature)) {
            return;
        }
        this.recentSignatures.set(signature, Date.now());

        const logMessages = logs.logs || [];
        const isTokenCreation = logMessages.some(log =>
            log.includes('Instruction: Create') ||
            log.includes('initializeMint') ||
            (log.includes('Instruction:') && log.includes('Create'))
        );

        if (!isTokenCreation) {
            return;
        }

        console.log(`🟣 ${platform} token detected: ${signature.substring(0, 12)}...`);

        setTimeout(() => {
            this.processTokenImmediately(signature, platform, grpcTransaction);
        }, 100);
    }

    async processTokenImmediately(signature, platform, grpcTransaction) {
        if (this.processingTokens.has(signature)) {
            return;
        }
        this.processingTokens.add(signature);

        console.log(`⚡ Processing: ${signature.substring(0, 12)}... (using gRPC data - ULTRA FAST)`);

        try {
            const tokenData = await this.extractCompleteTokenDataFromGrpc(grpcTransaction, signature, platform);

            if (tokenData) {
                console.log(`🎯 TOKEN DATA READY - SENDING TO SERVER:`);
                console.log(JSON.stringify(tokenData, null, 2));

                await this.onTokenCallback(tokenData);
                console.log(`✅ Data sent to server`);
            } else {
                console.log(`❌ No token data extracted`);
            }

        } catch (error) {
            console.log(`❌ Processing error: ${error.message}`);
            console.error(error.stack);
        } finally {
            this.processingTokens.delete(signature);
        }
    }

    async extractCompleteTokenDataFromGrpc(grpcTransaction, signature, platform) {
        try {
            // Extract account keys from gRPC transaction
            let accountKeys = [];
            
            if (grpcTransaction.transaction && grpcTransaction.transaction.message) {
                const message = grpcTransaction.transaction.message;
                accountKeys = (message.accountKeys || []).map(key => {
                    if (typeof key === 'string') return new PublicKey(key);
                    if (Buffer.isBuffer(key)) return new PublicKey(key);
                    if (key.pubkey) return new PublicKey(key.pubkey);
                    return new PublicKey(key.toString());
                });
            }

            console.log(`🔍 Extracted ${accountKeys.length} account keys from gRPC`);

            // Get creator address (first account is always fee payer)
            let creatorAddress = 'Unknown';
            if (accountKeys.length > 0 && accountKeys[0]) {
                creatorAddress = accountKeys[0].toString();
            }
            console.log(`👤 Creator: ${creatorAddress}`);

            // Find mint address from gRPC transaction
            let mint = this.findMintInGrpcTransaction(grpcTransaction);

            if (!mint) {
                console.log('❌ No mint address found in gRPC transaction');
                return null;
            }

            console.log(`✅ Found mint: ${mint.substring(0, 16)}...`);

            if (this.recentMints.has(mint)) {
                console.log(`↩ Already processed mint`);
                return null;
            }
            this.recentMints.set(mint, Date.now());

            const mintPublicKey = new PublicKey(mint);

            // CALCULATE BONDING CURVE ADDRESS
            let bondingCurveAddress = null;
            if (platform === 'pump.fun') {
                const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
                    [Buffer.from("bonding-curve"), mintPublicKey.toBytes()],
                    PUMP_FUN_PROGRAM
                );
                bondingCurveAddress = bondingCurvePDA.toString();
                console.log(`📊 Bonding Curve: ${bondingCurveAddress}`);
            }

            // Extract token info from gRPC transaction (decimals and supply)
            let tokenInfo = this.extractTokenInfoFromGrpc(grpcTransaction, mint);
            console.log(`🪙 Token info: ${tokenInfo.supply} supply, ${tokenInfo.decimals} decimals`);

            // Extract metadata from gRPC transaction logs
            const completeMetadata = this.extractMetadataFromGrpc(grpcTransaction);
            console.log(`📝 Metadata: ${completeMetadata.name} (${completeMetadata.symbol})`);

            // Extract bonding curve data from gRPC transaction
            const financialData = this.extractFinancialDataFromGrpc(grpcTransaction, platform);

            // Get block time from gRPC transaction
            const blockTime = grpcTransaction.slot || null;

            // CREATE COMPLETE TOKEN DATA - SAME STRUCTURE AS BEFORE
            const tokenData = {
                id: mint,
                mint: mint,
                name: completeMetadata.name,
                symbol: completeMetadata.symbol,
                description: completeMetadata.description,
                image: completeMetadata.image,
                metadataUri: completeMetadata.uri,

                marketCap: financialData.marketCap,
                marketCapSol: parseFloat(financialData.marketCap || 0),
                price: financialData.price,
                liquidity: financialData.liquidity,
                solAmount: parseFloat(financialData.solAmount || financialData.liquidity || 0),
                totalSupply: tokenInfo.supply,
                decimals: tokenInfo.decimals,

                creator: creatorAddress,
                traderPublicKey: creatorAddress,
                creatorProfile: null,

                twitter: completeMetadata.twitter,
                twitterType: this.extractTwitterType(completeMetadata.twitter),
                twitterHandle: this.extractTwitterHandle(completeMetadata.twitter),
                twitterCommunityId: this.extractTwitterCommunityId(completeMetadata.twitter),
                twitterAdmin: this.extractTwitterAdmin(completeMetadata.twitter),
                website: completeMetadata.website,
                telegram: completeMetadata.telegram,
                discord: completeMetadata.discord,

                platform: platform,
                created: blockTime ? new Date(blockTime * 1000).toISOString() : new Date().toISOString(),
                creationSignature: signature,

                bondingCurveAddress: bondingCurveAddress,
                bondingCurveKey: bondingCurveAddress,
                pool: platform === 'pump.fun' ? 'pump' : 'bonk',

                complete: true,
                metadataAlreadyFetched: true,
                featured: false,
                trending: false,
                verified: false,

                volume24h: '0',
                priceChange24h: '0',
                holders: '0',

                tokenProgram: TOKEN_PROGRAM_ID.toString(),
                associatedTokenAccount: this.calculateAssociatedTokenAccount(mintPublicKey, creatorAddress),

                tags: completeMetadata.tags || [],
                category: completeMetadata.category || 'meme',
                audit: completeMetadata.audit || 'unaudited'
            };

            return tokenData;

        } catch (error) {
            console.log(`❌ Extraction error: ${error.message}`);
            console.error(error);
            return null;
        }
    }

    extractTokenInfoFromGrpc(grpcTransaction, mint) {
        try {
            // Try to extract from postTokenBalances
            if (grpcTransaction.meta && grpcTransaction.meta.postTokenBalances) {
                for (const balance of grpcTransaction.meta.postTokenBalances) {
                    if (balance.mint === mint) {
                        return {
                            supply: balance.uiTokenAmount?.amount || '1000000000',
                            decimals: balance.uiTokenAmount?.decimals || 6
                        };
                    }
                }
            }

            // Default values if not found
            return {
                supply: '1000000000',
                decimals: 6
            };
        } catch (error) {
            console.log(`⚠️ Error extracting token info from gRPC: ${error.message}`);
            return {
                supply: '1000000000',
                decimals: 6
            };
        }
    }

    extractMetadataFromGrpc(grpcTransaction) {
        const metadata = {
            name: 'Unknown',
            symbol: 'UNKNOWN',
            description: 'A new token on Solana',
            image: null,
            uri: null,
            twitter: null,
            website: null,
            telegram: null,
            discord: null,
            tags: [],
            category: 'meme'
        };

        try {
            // Extract from logs
            const logs = grpcTransaction.meta?.logMessages || [];
            
            for (const log of logs) {
                // Look for metadata in logs
                if (log.includes('name:')) {
                    const nameMatch = log.match(/name:\s*([^,\]]+)/i);
                    if (nameMatch) metadata.name = nameMatch[1].trim();
                }
                if (log.includes('symbol:')) {
                    const symbolMatch = log.match(/symbol:\s*([^,\]]+)/i);
                    if (symbolMatch) metadata.symbol = symbolMatch[1].trim();
                }
                if (log.includes('uri:')) {
                    const uriMatch = log.match(/uri:\s*([^\s,\]]+)/i);
                    if (uriMatch) metadata.uri = uriMatch[1].trim();
                }
            }

            // Try to extract from instruction data if available
            if (grpcTransaction.transaction?.message?.instructions) {
                for (const instruction of grpcTransaction.transaction.message.instructions) {
                    if (instruction.data) {
                        try {
                            const data = Buffer.isBuffer(instruction.data) ? 
                                instruction.data : Buffer.from(instruction.data, 'base64');
                            
                            // Try to parse name and symbol from instruction data
                            const parsed = this.parseMetadataFromInstructionData(data);
                            if (parsed.name) metadata.name = parsed.name;
                            if (parsed.symbol) metadata.symbol = parsed.symbol;
                            if (parsed.uri) metadata.uri = parsed.uri;
                        } catch (e) {
                            // Skip if parsing fails
                        }
                    }
                }
            }

        } catch (error) {
            console.log(`⚠️ Error extracting metadata from gRPC: ${error.message}`);
        }

        return metadata;
    }

    parseMetadataFromInstructionData(data) {
        const parsed = { name: null, symbol: null, uri: null };
        
        try {
            // This is a simplified parser - adjust based on actual instruction format
            let offset = 8; // Skip discriminator
            
            if (data.length > offset + 4) {
                const nameLen = data.readUInt32LE(offset);
                offset += 4;
                if (nameLen > 0 && nameLen < 100 && data.length >= offset + nameLen) {
                    parsed.name = data.slice(offset, offset + nameLen).toString('utf8').replace(/\0/g, '').trim();
                    offset += nameLen;
                }
            }
            
            if (data.length > offset + 4) {
                const symbolLen = data.readUInt32LE(offset);
                offset += 4;
                if (symbolLen > 0 && symbolLen < 20 && data.length >= offset + symbolLen) {
                    parsed.symbol = data.slice(offset, offset + symbolLen).toString('utf8').replace(/\0/g, '').trim();
                    offset += symbolLen;
                }
            }
            
            if (data.length > offset + 4) {
                const uriLen = data.readUInt32LE(offset);
                offset += 4;
                if (uriLen > 0 && uriLen < 500 && data.length >= offset + uriLen) {
                    parsed.uri = data.slice(offset, offset + uriLen).toString('utf8').replace(/\0/g, '').trim();
                }
            }
        } catch (error) {
            // Return what we have
        }
        
        return parsed;
    }

    extractFinancialDataFromGrpc(grpcTransaction, platform) {
        try {
            // Try to extract bonding curve data from account data in gRPC
            if (grpcTransaction.meta?.postBalances && grpcTransaction.meta?.preBalances) {
                const postBalances = grpcTransaction.meta.postBalances;
                const preBalances = grpcTransaction.meta.preBalances;
                
                // Look for SOL changes to estimate liquidity
                for (let i = 0; i < postBalances.length; i++) {
                    const change = postBalances[i] - (preBalances[i] || 0);
                    if (change > 0) {
                        const solAmount = change / 1000000000;
                        const marketCap = solAmount * 2;
                        return {
                            marketCap: marketCap.toFixed(4),
                            price: '0.0000000001',
                            liquidity: solAmount.toFixed(4),
                            solAmount: solAmount.toFixed(4)
                        };
                    }
                }
            }

            // Default values
            return { 
                marketCap: '0', 
                price: '0', 
                liquidity: '0', 
                solAmount: '0' 
            };
        } catch (error) {
            console.log(`⚠️ Error extracting financial data from gRPC: ${error.message}`);
            return { 
                marketCap: '0', 
                price: '0', 
                liquidity: '0', 
                solAmount: '0' 
            };
        }
    }

    calculateAssociatedTokenAccount(mintPublicKey, creatorAddress) {
        try {
            if (creatorAddress === 'Unknown') return null;

            const creatorPubkey = new PublicKey(creatorAddress);
            const [ata] = PublicKey.findProgramAddressSync(
                [creatorPubkey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mintPublicKey.toBuffer()],
                new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
            );
            return ata.toString();
        } catch (error) {
            console.log(`⚠️ Could not calculate ATA: ${error.message}`);
        }
        return null;
    }

    findMintInGrpcTransaction(grpcTransaction) {
        try {
            // Try to find mint in meta.postTokenBalances
            if (grpcTransaction.meta && grpcTransaction.meta.postTokenBalances) {
                for (const balance of grpcTransaction.meta.postTokenBalances) {
                    if (balance.mint && this.isValidSolanaAddress(balance.mint)) {
                        return balance.mint;
                    }
                }
            }

            // Try to find in account keys (usually index 2-6)
            if (grpcTransaction.transaction && grpcTransaction.transaction.message) {
                const accountKeys = grpcTransaction.transaction.message.accountKeys || [];
                for (let i = 2; i < Math.min(accountKeys.length, 6); i++) {
                    const key = accountKeys[i];
                    let address;
                    if (typeof key === 'string') {
                        address = key;
                    } else if (Buffer.isBuffer(key)) {
                        address = new PublicKey(key).toString();
                    } else if (key.pubkey) {
                        address = key.pubkey.toString();
                    } else {
                        address = key.toString();
                    }
                    
                    if (this.isValidSolanaAddress(address)) {
                        return address;
                    }
                }
            }
        } catch (error) {
            console.log(`⚠️ Error finding mint: ${error.message}`);
        }
        return null;
    }

    isValidSolanaAddress(address) {
        if (typeof address !== 'string') return false;
        if (address.length < 32 || address.length > 44) return false;
        const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
        return base58Regex.test(address);
    }

    extractTwitterType(twitterUrl) {
        if (!twitterUrl) return null;
        if (twitterUrl.includes('/status/')) return 'tweet';
        if (twitterUrl.includes('/communities/')) return 'community';
        if (twitterUrl.includes('twitter.com/') || twitterUrl.includes('x.com/')) return 'individual';
        return 'individual';
    }

    extractTwitterHandle(twitterUrl) {
        if (!twitterUrl) return null;
        const tweetMatch = twitterUrl.match(/(?:twitter\.com\/|x\.com\/)([a-zA-Z0-9_]+)\/status\//i);
        if (tweetMatch) return tweetMatch[1].toLowerCase();
        const profileMatch = twitterUrl.match(/(?:twitter\.com\/|x\.com\/)(?!i\/communities\/)([a-zA-Z0-9_]+)/i);
        if (profileMatch) return profileMatch[1].toLowerCase();
        return null;
    }

    extractTwitterCommunityId(twitterUrl) {
        if (!twitterUrl) return null;
        const match = twitterUrl.match(/\/communities\/(\d+)/i);
        return match ? match[1] : null;
    }

    extractTwitterAdmin(twitterUrl) {
        const handle = this.extractTwitterHandle(twitterUrl);
        const communityId = this.extractTwitterCommunityId(twitterUrl);
        return handle || communityId || null;
    }

    stop() {
        console.log('🛑 Stopping blockchain listener...');
        
        // ✅ Stop ping interval first
        this.stopPingInterval();
        
        // ✅ Close stream gracefully
        if (this.grpcStream) {
            try {
                this.grpcStream.end();
                console.log('✅ gRPC stream closed');
            } catch (error) {
                console.error('❌ Error closing stream:', error.message);
            }
            this.grpcStream = null;
        }
        
        // ✅ Mark as not subscribed
        this.isSubscribed = false;
        this.isGrpcConnected = false;
        
        // ✅ Don't destroy the client - we might reuse it
        // this.grpcClient = null;
        
        console.log('🛑 Blockchain listener stopped');
    }
}

module.exports = { BlockchainTokenListener };
