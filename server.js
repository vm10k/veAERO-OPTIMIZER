require('dotenv').config();
const { ethers } = require("ethers");
const WebSocket = require('ws');
const fs = require('fs');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// =================================================================================
// --- SERVER CONFIGURATION & CONSTANTS ---
// =================================================================================
const config = {
    port: 3000,
     rpcUrls:[
        "GET FREE TIER RPC FROM ALCHEMY",        
        "GET FREE TIER RPC FROM ANKR",      
		"GET FREE TIER RPC FROM TENDERLY",      
        "https://base-mainnet.public.blastapi.io"      
    ],
    voteLeadTime: 60, 
    fetchInterval: 300000, 
    voterAddress: "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5",
    minterAddress: "0xeb018363f0a9af8f91f06fee6613a751b2a33fe5",
    distributorAddress: "0x227f65131A261548b057215bB1D5Ab2997964C7d",
    veNftAddress: "0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4" 
};

let provider; 
let providers =[]; 
let providerIndex = 0;

function getNextProvider() {
    if (providers.length === 0) return provider;
    const p = providers[providerIndex];
    providerIndex = (providerIndex + 1) % providers.length;
    return p;
}

const settingsFilePath = './settings.json';
const transactionsFilePath = './transactions.json';
const epochsFilePath = './epochs.json';
function getSafeConfig() {
    const { privateKey, signer, ...safeConfig } = autovoterConfig;
    return { 
        ...safeConfig, 
        hasWallet: !!signer,
        privateKey: undefined 
    };
}
// =================================================================================
// --- ABI DEFINITIONS ---
// =================================================================================
const abi = {
    voter: [
        "function epochVoteEnd(uint256 timestamp) view returns (uint256)",
        "function totalWeight() view returns (uint256)",
        "function length() view returns (uint256)",
        "function pools(uint256 index) view returns (address)",
        "function gauges(address pool) view returns (address)",
        "function gaugeToFees(address gauge) view returns (address)",
        "function gaugeToBribe(address gauge) view returns (address)",
        "function weights(address pool) view returns (uint256)",
        "function isAlive(address gauge) view returns (bool)",
		"function claimFees(address[] _fees, address[][] _tokens, uint256 _tokenId) external", 
		
        "function vote(uint256 tokenId, address[] calldata _poolVote, uint256[] calldata _weights) external",
        "function claimBribes(address[] _bribes, address[][] _tokens, uint256 _tokenId) external",
        "function votes(uint256 tokenId, address pool) view returns (uint256)"
    ],
    minter: ["function weekly() view returns (uint256)"],
     distributor: [
        "function claim(uint256 _tokenId) returns (uint256)",
        "function claimable(uint256 _tokenId) view returns (uint256)" 
    ],
    rewardContract: [
        "function rewardsListLength() view returns (uint256)",
        "function rewards(uint256 index) view returns (address)",
		"function earned(address token, uint256 tokenId) view returns (uint256)", 
        "function tokenRewardsPerEpoch(address token, uint256 epochStart) view returns (uint256)"
    ],
    erc20: ["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)", "function approve(address spender, uint256 amount) external returns (bool)"],
    pair: ["function token0() view returns (address)", "function token1() view returns (address)"],
   veNft: [
        "function balanceOfNFTAt(uint256 _tokenId, uint256 _t) view returns (uint256)",
        "function increaseAmount(uint256 _tokenId, uint256 _value) external" 
    ]
};

let voterContract, minterContract, veNftContract, distributorContract;
const tokenInfoCache = {};

function initBlockchain(rpcs) {
    try {
        if (!rpcs) rpcs = config.rpcUrls;

        let rpcArray = Array.isArray(rpcs) ? rpcs : rpcs.split(',').map(s => s.trim());
        console.log(`Connecting to ${rpcArray.length} Blockchain RPC(s)...`);
        
        
        providers = rpcArray.map(url => new ethers.JsonRpcProvider(url, 8453, { staticNetwork: true }));
        provider = providers[0]; 
        
        voterContract = new ethers.Contract(config.voterAddress, abi.voter, provider);
        minterContract = new ethers.Contract(config.minterAddress, abi.minter, provider);
        veNftContract = new ethers.Contract(config.veNftAddress, abi.veNft, provider);
        distributorContract = new ethers.Contract(config.distributorAddress, abi.distributor, provider);
        
        if (autovoterConfig.privateKey) {
            autovoterConfig.signer = new ethers.Wallet(autovoterConfig.privateKey, provider);
        }
    } catch (e) {
        console.error("Failed to initialize blockchain provider:", e.message);
    }
}

// =================================================================================
// --- GLOBAL STATE & PERSISTENCE ---
// =================================================================================
let latestFetchedData = { pools: [], summary: {}, prices: {} };
let isFetching = false;
let lastEpochVoted = null;
let transactionHistory = [];
let epochHistory = {};
let compoundIntervalTimer = null;

const knownTokenAddresses = new Set(); 


let autovoterConfig = {
    signer: null,
    tokenIds: [], 
    votePercentage: 100,
    enabled: false,
    voteStrategy: 'optimized', 
    diversificationPools: 3,
    scanMode: 'scheduled',
    rpcUrl: config.rpcUrl, 
    batchSize: 7,
    fetchDelayMs: 1200
};
let isLoopRunning = false;

function loadSettings() {
    try {
        console.log("Loading settings...");

        if (fs.existsSync(settingsFilePath)) {
            const data = fs.readFileSync(settingsFilePath, 'utf8');
            const savedSettings = JSON.parse(data);
            
            autovoterConfig.tokenIds = savedSettings.tokenIds || []; 
            autovoterConfig.tokenId = savedSettings.tokenId || (autovoterConfig.tokenIds[0] || null);
            
            autovoterConfig.votePercentage = savedSettings.votePercentage || 100;
            autovoterConfig.enabled = savedSettings.enabled || false;
            autovoterConfig.voteStrategy = savedSettings.voteStrategy || 'optimized';
            autovoterConfig.diversificationPools = savedSettings.diversificationPools || 3;
            autovoterConfig.scanMode = savedSettings.scanMode || 'scheduled'; 
            
            autovoterConfig.rpcUrl = savedSettings.rpcUrl || config.rpcUrl;
            autovoterConfig.batchSize = savedSettings.batchSize || 7;
            autovoterConfig.fetchDelayMs = savedSettings.fetchDelayMs || 1000;

            console.log(`Loaded preferences for ${autovoterConfig.tokenIds.length} Token IDs.`);
        } else {
            console.log("settings.json not found, using default configuration.");
            autovoterConfig.rpcUrl = config.rpcUrl;
        }

        initBlockchain(autovoterConfig.rpcUrl);

        
        const envKey = process.env.PRIVATE_KEY;

        if (envKey && envKey.trim() !== "") {
            try {
                autovoterConfig.signer = new ethers.Wallet(envKey, provider);
                autovoterConfig.privateKey = envKey; 
                
                console.log(`[SECURITY] Wallet initialized from .env: ${autovoterConfig.signer.address}`);
            } catch (e) {
                console.error("[SECURITY ERROR] The Private Key in your .env file is invalid:", e.message);
            }
        } else {
            console.warn("[SECURITY] No PRIVATE_KEY found in .env. Auto-voting will be disabled until a key is provided via Dashboard.");
        }

    } catch (error) {
        console.error("Critical error during loadSettings:", error.message);
        initBlockchain(config.rpcUrl);
    }
}
function loadTransactions() {
    try {
        if (fs.existsSync(transactionsFilePath)) {
            const data = fs.readFileSync(transactionsFilePath, 'utf8');
            transactionHistory = JSON.parse(data);
            console.log(`Loaded ${transactionHistory.length} transactions from history.`);
        }
    } catch (error) {
        console.error("Could not load transactions:", error);
        transactionHistory = [];
    }
}

function loadEpochHistory() {
    try {
        if (fs.existsSync(epochsFilePath)) {
            const data = fs.readFileSync(epochsFilePath, 'utf8');
            epochHistory = JSON.parse(data);
            console.log(`Loaded history for ${Object.keys(epochHistory).length} epochs.`);
        }
    } catch (error) {
        console.error("Could not load epoch history, starting fresh:", error.message);
        epochHistory = {};
    }
}

function saveEpochHistory() {
    try {
        fs.writeFileSync(epochsFilePath, JSON.stringify(epochHistory, null, 2), 'utf8');
    } catch (e) {
        console.error("Failed to save epoch history:", e);
    }
}

function logTransaction(type, txHash, pools, estimatedValueUSD, status) {
	 if (!transactionHistory || !Array.isArray(transactionHistory)) {
        transactionHistory =[];
    }
    const txData = {
        timestamp: Date.now(),
        type: type, 
        hash: txHash,
        pools: pools,
        value: estimatedValueUSD || 0,
        status: status
    };
    transactionHistory.unshift(txData);

    if (transactionHistory.length > 100) {
        transactionHistory = transactionHistory.slice(0, 100);
    }

    try {
        fs.writeFileSync(transactionsFilePath, JSON.stringify(transactionHistory, null, 2), 'utf8');
    } catch (e) {
        console.error("Failed to save transaction history:", e);
    }

    const totalEarnings = transactionHistory.reduce((acc, tx) => acc + (tx.value || 0), 0);
    broadcast({ type: 'transaction_update', data: { history: transactionHistory, totalEarnings } });
}

// =================================================================================
// --- EPOCH TRACKING LOGIC ---
// =================================================================================
async function trackEpochPerformance(summary, pools) {
    if (!summary || !summary.epochVoteEnd) return;

    const AERODROME_START = 1693353600;
    const epochDuration = 604800;
    
    const currentEpochId = Math.floor((summary.epochVoteEnd - AERODROME_START) / epochDuration);
    
    const targetDisplayEpochId = currentEpochId - 1;

    let indexApr = 0;
    const validPools = pools.filter(p => p.tvl >= 100000);
    const sortedPools = [...validPools].sort((a, b) => b.totalAPR - a.totalAPR);
    const top3 = sortedPools.slice(0, 3);
    if (top3.length > 0) {
        indexApr = top3.reduce((sum, p) => sum + p.totalAPR, 0) / top3.length;
    }

    if (!epochHistory[targetDisplayEpochId]) {
        epochHistory[targetDisplayEpochId] = {
            epochId: targetDisplayEpochId,
            indexApr: parseFloat(indexApr.toFixed(2)),
            userApr: 0,
            earnings: 0,
            poolsVoted: 0,
            timestamp: Date.now()
        };
    } else {
        epochHistory[targetDisplayEpochId].indexApr = parseFloat(indexApr.toFixed(2));
    }

    saveEpochHistory();

    broadcast({ 
        type: 'header_stats_update', 
        data: {
            userApr: epochHistory[targetDisplayEpochId].userApr,
            indexApr: epochHistory[targetDisplayEpochId].indexApr,
            epochId: targetDisplayEpochId
        }
    });

    broadcast({ type: 'epoch_history_update', data: epochHistory });
}

async function recordRealizedEarnings(usdAmount) {
    if (usdAmount <= 0) return;

    const currentTimestamp = Math.floor(Date.now() / 1000);
    const AERODROME_START = 1693353600;
    const epochDuration = 604800; 
    
    const targetEpochId = Math.floor((currentTimestamp - AERODROME_START) / epochDuration) - 1;
if (!latestFetchedData.prices || Object.keys(latestFetchedData.prices).length === 0) {
        console.error("[ANALYSIS] Prices not loaded yet. Skipping historical recording.");
        return;
    }
    if (!epochHistory[targetEpochId]) {
        epochHistory[targetEpochId] = { 
            epochId: targetEpochId, 
            indexApr: 0, 
            userApr: 0, 
            earnings: 0, 
            timestamp: Date.now() 
        };
    }

    epochHistory[targetEpochId].earnings += usdAmount;

    let totalUserPower = 0;
    
    const idsToCheck = [...autovoterConfig.tokenIds];
    if (autovoterConfig.tokenId && !idsToCheck.includes(autovoterConfig.tokenId)) {
        idsToCheck.push(autovoterConfig.tokenId);
    }

    for (const id of idsToCheck) {
        try {
            
            const historicalTime = currentTimestamp - (epochDuration / 2);
            const rawPower = await veNftContract.balanceOfNFTAt(id, historicalTime);
            totalUserPower += parseFloat(ethers.formatEther(rawPower));
        } catch (e) {
            console.error(`[ANALYSIS ERROR] Failed to fetch historical power for NFT ${id}:`, e.message);
        }
    }

    const AERO_ADDRESS = '0x940181a94A35A4569E4529A3CDfB74e38FD98631'.toLowerCase();
    const aeroPrice = latestFetchedData.prices[AERO_ADDRESS] || 0;
    const totalPowerValueUsd = totalUserPower * aeroPrice;

    if (totalPowerValueUsd > 0) {
        const calculatedApr = (epochHistory[targetEpochId].earnings / totalPowerValueUsd) * 52 * 100;
        epochHistory[targetEpochId].userApr = parseFloat(calculatedApr.toFixed(2));
    }

    console.log(`
==================================================
💰 REALIZED EARNINGS RECORDED
--------------------------------------------------
Epoch ID:      ${targetEpochId}
Amount Added:  $${usdAmount.toFixed(2)}
Total Epoch:   $${epochHistory[targetEpochId].earnings.toFixed(2)}
Total Power:   ${totalUserPower.toFixed(2)} veAERO ($${totalPowerValueUsd.toFixed(2)})
Final APR:     ${epochHistory[targetEpochId].userApr}%
==================================================
    `);

    saveEpochHistory();
    broadcast({ type: 'epoch_history_update', data: epochHistory });
}


// =================================================================================
// --- AUTO-VOTER LOGIC ---
// =================================================================================
async function getProjectedVoteOutcome(tokenIdsInput, votePercentage) {
    if (!tokenIdsInput || isNaN(parseFloat(votePercentage))) {
        throw new Error("Invalid token ID or vote percentage for simulation.");
    }
    if (!latestFetchedData.pools || latestFetchedData.pools.length === 0) {
        throw new Error("Pool data not yet available for simulation. Please wait for the initial scan to complete.");
    }

    const ids = typeof tokenIdsInput === 'string' 
        ? tokenIdsInput.split(',').map(id => id.trim()).filter(id => id !== '')
        : [tokenIdsInput];

    const currentTimestamp = Math.floor(Date.now() / 1000);
    let totalUserVotingPower = 0n;

    for (const id of ids) {
        try {
            const power = await veNftContract.balanceOfNFTAt(id, currentTimestamp);
            totalUserVotingPower += power;
        } catch (e) {
            console.warn(`Simulation: Could not fetch power for ID ${id}. Skipping.`);
        }
    }

    if (totalUserVotingPower === 0n) {
        throw new Error(`The provided Token IDs have zero total voting power.`);
    }

    const AERO_ADDRESS = '0x940181a94A35A4569E4529A3CDfB74e38FD98631'.toLowerCase();
    const aeroPrice = latestFetchedData.prices[AERO_ADDRESS] || 0;
    if (aeroPrice === 0) {
        throw new Error("AERO price is not available. Cannot run simulation.");
    }

    const percentageAsInteger = BigInt(Math.round(votePercentage * 100));
    const userVoteWeight = (totalUserVotingPower * percentageAsInteger) / 10000n;
    const userVoteWeightEther = Number(ethers.formatEther(userVoteWeight));
    const userVoteValueUSD = userVoteWeightEther * aeroPrice;

    const simulatedPools = latestFetchedData.pools.map(pool => {
        const totalRewardsUSD = pool.totalFeesUSD + pool.totalBribesUSD;
        const newTotalPoolPower = BigInt(pool.votingPower) + userVoteWeight;
        const newTotalPoolPowerEther = Number(ethers.formatEther(newTotalPoolPower));
        
        const userShare = (newTotalPoolPowerEther > 0) ? userVoteWeightEther / newTotalPoolPowerEther : 0;
        const projectedUserWeeklyRewards = totalRewardsUSD * userShare;
        
        const projectedAPR = (userVoteValueUSD > 0) ? (projectedUserWeeklyRewards / userVoteValueUSD) * 52 * 100 : 0;

        return { ...pool, projectedAPR, projectedUserWeeklyRewards };
    });

    simulatedPools.sort((a, b) => b.projectedAPR - a.projectedAPR);
    return simulatedPools;
}
async function findOptimalDiversification(sortedPools, userVoteWeight) {
    let bestSetup = { poolCount: 0, totalRewards: 0, pools: [] };

    const calculateProjectedRewards = (pool, weight) => {
        const totalRewardsUSD = pool.totalFeesUSD + pool.totalBribesUSD;
        const newTotalPoolPower = BigInt(pool.votingPower) + weight;
        const userShare = Number(ethers.formatEther(weight)) / Number(ethers.formatEther(newTotalPoolPower));
        return totalRewardsUSD * userShare;
    };

    if (sortedPools.length === 0) return [];

    const rewardsForOnePool = calculateProjectedRewards(sortedPools[0], userVoteWeight);
    bestSetup = { poolCount: 1, totalRewards: rewardsForOnePool, pools: [sortedPools[0]] };

    for (let n = 2; n <= Math.min(10, sortedPools.length); n++) {
        const currentPools = sortedPools.slice(0, n);
        const weightPerPool = userVoteWeight / BigInt(n);

        let currentTotalRewards = 0;
        for (const pool of currentPools) {
            currentTotalRewards += calculateProjectedRewards(pool, weightPerPool);
        }

        if (currentTotalRewards > bestSetup.totalRewards) {
            bestSetup = { poolCount: n, totalRewards: currentTotalRewards, pools: currentPools };
        } else {
            break;
        }
    }

    console.log(`Optimal strategy found: Diversify across ${bestSetup.poolCount} pools.`);
    return bestSetup.pools;
}

async function executeVote() {
    if (!autovoterConfig.signer || !autovoterConfig.tokenIds || autovoterConfig.tokenIds.length === 0) {
        broadcast({ type: 'autovoter_status', message: 'Bot not configured. Please save settings with at least one Token ID.' });
        return;
    }

    const currentEpochStart = Math.floor(Date.now() / (1000 * 60 * 60 * 24 * 7)) * (60 * 60 * 24 * 7);
    
    if (lastEpochVoted === currentEpochStart) {
        console.log("Vote for this epoch already attempted. Skipping.");
        return;
    }

    if (!latestFetchedData.pools || latestFetchedData.pools.length === 0) {
        console.log("⚠️ SNIPER: Attempted to vote, but pool data is still loading. Retrying in 5s...");
        return; 
    }

    console.log(`EXECUTE VOTE: Process started for ${autovoterConfig.tokenIds.length} NFTs.`);
    lastEpochVoted = currentEpochStart;

    try {
        broadcast({ type: 'autovoter_status', message: 'Analyzing pools for optimal strategy...' });

        const simulationId = autovoterConfig.tokenIds[0];
        const projection = await getProjectedVoteOutcome(simulationId, autovoterConfig.votePercentage);
        if (!projection || projection.length === 0) throw new Error("No pool data available to execute vote.");

        let poolsToVoteFor =[];
        let estimatedTotalRewardValue = 0; 

        if (autovoterConfig.voteStrategy === 'optimized') {
            const currentTimestamp = Math.floor(Date.now() / 1000);
            const simPower = await veNftContract.balanceOfNFTAt(simulationId, currentTimestamp);
            poolsToVoteFor = await findOptimalDiversification(projection, simPower);
        } 
        else if (autovoterConfig.voteStrategy === 'diversified') {
            const numPools = Math.min(autovoterConfig.diversificationPools, projection.length);
            poolsToVoteFor = projection.slice(0, numPools);
        } 
        else {
            poolsToVoteFor = [projection[0]];
        }

        if (poolsToVoteFor.length === 0) throw new Error("Strategy resulted in no pools.");

        const poolNames = poolsToVoteFor.map(p => p.name);
        const percentageAsInteger = BigInt(Math.round(autovoterConfig.votePercentage * 100));
        let totalEstimatedValue = 0;
        poolsToVoteFor.forEach(p => {
             if (p.projectedUserWeeklyRewards) totalEstimatedValue += p.projectedUserWeeklyRewards;
        });

        console.log(`Targeting ${poolsToVoteFor.length} pools: ${poolNames.join(', ')}`);
        broadcast({ type: 'autovoter_status', message: `Voting for: ${poolNames.join(', ')}` });
        
        let successfulHashes =[];
        const voterContractWithSigner = voterContract.connect(autovoterConfig.signer);
        const currentTimestamp = Math.floor(Date.now() / 1000);

        let currentNonce = await autovoterConfig.signer.getNonce("latest");
        const tokenIds = autovoterConfig.tokenIds;

        for (let i = 0; i < tokenIds.length; i++) {
            const tokenId = tokenIds[i];
            try {
                const totalVotingPower = await veNftContract.balanceOfNFTAt(tokenId, currentTimestamp);
                
                if (totalVotingPower === 0n) {
                    console.log(`Skipping Token ID ${tokenId}: 0 Voting Power.`);
                    continue; 
                }

                const usedVotingPower = (totalVotingPower * percentageAsInteger) / 10000n;
                let weightPerPool = usedVotingPower / BigInt(poolsToVoteFor.length);
                
                if (weightPerPool === 0n) weightPerPool = 1n; 
                
                const weightDistribution = poolsToVoteFor.map(() => weightPerPool);
                const poolVoteAddresses = poolsToVoteFor.map(p => p.address);

                console.log(`Voting ID ${tokenId} (Nonce: ${currentNonce})...`);
                
                const tx = await voterContractWithSigner.vote(tokenId, poolVoteAddresses, weightDistribution, {
                    nonce: currentNonce
                });
                
                currentNonce++; 
                
                broadcast({ type: 'autovoter_status', message: `Vote Tx sent for ID ${tokenId}. Waiting for confirmation...` });
                
                await tx.wait(); 
                successfulHashes.push(tx.hash);
                console.log(`✅ Confirmed: ${tx.hash}`);

            } catch (err) {
                console.error(`❌ Error preparing/sending vote for ID ${tokenId}: ${err.shortMessage || err.message}`);
            }
        }

        if (successfulHashes.length === 0) {
            throw new Error("All vote transactions failed or reverted.");
        }

        broadcast({ type: 'autovoter_status', message: `SUCCESS! All votes processed.` });
        
        let finalHashLabel = successfulHashes.length === 1 ? successfulHashes[0] : 'Multiple-NFTs';
        logTransaction('Auto-Vote', finalHashLabel, poolNames, totalEstimatedValue, 'Confirmed');
        
   } catch (error) {
        console.error("VOTE EXECUTION FAILED:", error);
        lastEpochVoted = null; 
        broadcast({ type: 'autovoter_status', message: `CRITICAL ERROR: ${error.message}` });
        logTransaction('Auto-Vote', 'Failed', [], 0, 'Failed: ' + error.message);
    }
}

async function executeManualVote(votes) {
    if (!autovoterConfig.signer || !autovoterConfig.tokenId) {
        throw new Error("Bot not configured. Please enter Private Key and Token ID in Settings.");
    }

    if (!votes || votes.length === 0) throw new Error("No pools selected to vote.");

    console.log(`MANUAL VOTE: Preparing to vote for ${votes.length} pools...`);

    const currentTimestamp = Math.floor(Date.now() / 1000);
    const totalVotingPower = await veNftContract.balanceOfNFTAt(autovoterConfig.tokenId, currentTimestamp);

    if (totalVotingPower === 0n) throw new Error("Token ID has 0 voting power.");

    const poolAddresses = [];
    const weights = [];
    const poolNames = [];

    for (const vote of votes) {
        const percent = parseFloat(vote.percent);
        if (percent <= 0) continue;

        const weight = (totalVotingPower * BigInt(Math.floor(percent * 100))) / 10000n;

        poolAddresses.push(vote.address);
        weights.push(weight);

        const pObj = latestFetchedData.pools.find(p => p.address.toLowerCase() === vote.address.toLowerCase());
        poolNames.push(pObj ? pObj.name : "Unknown");
    }

    if (poolAddresses.length === 0) throw new Error("No pools with > 0% selected.");

    const voterContractWithSigner = voterContract.connect(autovoterConfig.signer);

    console.log(`Sending Manual Vote Transaction for ${poolNames.join(', ')}...`);
    const tx = await voterContractWithSigner.vote(autovoterConfig.tokenId, poolAddresses, weights);

    console.log(`Manual Vote Tx Sent: ${tx.hash}`);

    logTransaction('Manual-Vote', tx.hash, poolNames, 0, 'Pending');

    await tx.wait();
    console.log(`Manual Vote Confirmed.`);

    if (transactionHistory.length > 0 && transactionHistory[0].hash === tx.hash) {
        transactionHistory[0].status = 'Confirmed';
        fs.writeFileSync(transactionsFilePath, JSON.stringify(transactionHistory, null, 2), 'utf8');
        broadcast({ type: 'transaction_update', data: { history: transactionHistory, totalEarnings: 0 } });
    }
    await trackEpochPerformance(latestFetchedData.summary, latestFetchedData.pools);

    return tx.hash;
}

async function executeTestVote(poolAddress) {
    if (!autovoterConfig.signer || !autovoterConfig.tokenId) {
        throw new Error("Bot not configured. Please save settings with a Private Key first.");
    }

    console.log(`TEST VOTE: Preparing to vote 1% on ${poolAddress}...`);
    broadcast({ type: 'autovoter_status', message: `Initiating TEST vote (1%) on ${poolAddress}...` });

    let poolName = "Unknown Pool";
    const poolObj = latestFetchedData.pools.find(p => p.address.toLowerCase() === poolAddress.toLowerCase());
    if (poolObj) poolName = poolObj.name;

    try {
        const currentTimestamp = Math.floor(Date.now() / 1000);
        const totalVotingPower = await veNftContract.balanceOfNFTAt(autovoterConfig.tokenId, currentTimestamp);
        if (totalVotingPower === 0n) throw new Error("Token ID has 0 voting power.");

        let testWeight = totalVotingPower / 100n;
        if (testWeight === 0n) testWeight = 1n;

        const voterContractWithSigner = voterContract.connect(autovoterConfig.signer);
        const tx = await voterContractWithSigner.vote(autovoterConfig.tokenId, [poolAddress], [testWeight]);

        broadcast({ type: 'autovoter_status', message: `Test Tx Sent: ${tx.hash}. Waiting...` });
        await tx.wait();

        console.log(`Test Vote Confirmed.`);
        broadcast({ type: 'autovoter_status', message: `SUCCESS: Test vote confirmed on chain.` });

        logTransaction('Test-Vote', tx.hash, [poolName], 0, 'Confirmed');
        return tx.hash;

    } catch (error) {
        console.error("TEST VOTE FAILED:", error);
        broadcast({ type: 'autovoter_status', message: `TEST ERROR: ${error.reason || error.message}` });
        logTransaction('Test-Vote', 'N/A', [poolName], 0, 'Failed');
        throw error;
    }
}

// =================================================================================
// --- WALLET SCANNING & ODOS SWAP ---
// =================================================================================
async function scanWalletBalances(userAddress) {
    if (!userAddress) return [];
    console.log(`Scanning balances for ${userAddress}...`);
    
   
    const rawBalances = [];
    const tokensToCheck = Array.from(knownTokenAddresses);
    
    
    const defaults = ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "0x940181a94A35A4569E4529A3CDfB74e38FD98631"];
    defaults.forEach(t => { if(!knownTokenAddresses.has(t)) tokensToCheck.push(t); });

   
    const QUESTION_MARK_ICON = "https://etherscan.io/images/main/empty-token.png"; 

    for (const tokenAddr of tokensToCheck) {
        try {
const tokenContract = new ethers.Contract(tokenAddr, abi.erc20, getNextProvider());
            
            const balance = await tokenContract.balanceOf(userAddress);
            
            if (balance > 0n) {
                const { symbol, decimals } = await getTokenInfo(tokenAddr);
                
               
                let logoUrl = `https://dd.dexscreener.com/ds-data/tokens/base/${tokenAddr.toLowerCase()}.png`;
                
               
                try {
                   
                    const response = await fetch(logoUrl, { method: 'HEAD', signal: AbortSignal.timeout(1500) });
                    if (!response.ok) {
                        logoUrl = QUESTION_MARK_ICON;
                    }
                } catch (err) {
                   
                    logoUrl = QUESTION_MARK_ICON;
                }

                rawBalances.push({
                    address: tokenAddr,
                    symbol,
                    decimals,
                    balance, 
                    logoUrl
                });
            }
        } catch (e) { /* ignore non-erc20s */ }
    }

    if (rawBalances.length === 0) return [];

    
    const addresses = rawBalances.map(t => t.address);
    const prices = await getLivePrices(addresses);
    
    const results = [];
    const MIN_USD_VALUE = 0.10; 

   
    for (const token of rawBalances) {
        const price = prices[token.address.toLowerCase()] || 0;
        const amountFmt = parseFloat(ethers.formatUnits(token.balance, token.decimals));
        const usdValue = amountFmt * price;

       
        if (usdValue >= MIN_USD_VALUE) {
            results.push({
                symbol: token.symbol,
                address: token.address,
                amount: token.balance.toString(),
                decimals: token.decimals,
                logoUrl: token.logoUrl,
                usdValue: usdValue 
            });
        }
    }

    
    results.sort((a, b) => b.usdValue - a.usdValue);

    return results;
}

async function executeOdosSwap(inputTokens, outputTokenAddress) {
    if (!autovoterConfig.signer) throw new Error("Wallet not configured. Cannot swap.");
    
    const userAddress = autovoterConfig.signer.address;
    console.log(`Initiating Odos Swap for ${inputTokens.length} tokens to ${outputTokenAddress}`);
    
    let successCount = 0;
    
    for (const token of inputTokens) {
        try {
            const inputAmount = token.amount;
            if (inputAmount === "0") continue;
            
            console.log(`Swapping ${token.symbol} (${inputAmount}) -> ${outputTokenAddress}`);
            broadcast({ type: 'swap_status', message: `Swapping ${token.symbol}...` });

            
            const quoteBody = {
                chainId: 8453, 
                inputTokens: [{ tokenAddress: token.address, amount: inputAmount }],
                outputTokens: [{ tokenAddress: outputTokenAddress, proportion: 1 }],
                userAddr: userAddress,
                slippageLimitPercent: 1.0, 
                referralCode: 0,
                compact: true
            };

            const quoteReq = await fetch("https://api.odos.xyz/sor/quote/v2", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(quoteBody)
            });

            if(!quoteReq.ok) throw new Error(`Odos Quote Failed: ${quoteReq.statusText}`);
            const quoteData = await quoteReq.json();
            
            
            const txReq = await fetch("https://api.odos.xyz/sor/assemble", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userAddr: userAddress, pathId: quoteData.pathId, simulate: false })
            });
            
            if(!txReq.ok) throw new Error(`Odos Assemble Failed: ${txReq.statusText}`);
            const txData = await txReq.json();
            
            const transaction = txData.transaction;
            
            
            const tokenContract = new ethers.Contract(token.address, abi.erc20, autovoterConfig.signer);
            broadcast({ type: 'swap_status', message: `Approving ${token.symbol}...` });
            const approveTx = await tokenContract.approve(transaction.to, inputAmount);
            await approveTx.wait();

            
            broadcast({ type: 'swap_status', message: `Sending Swap Tx for ${token.symbol}...` });
            const txResponse = await autovoterConfig.signer.sendTransaction({
                to: transaction.to,
                data: transaction.data,
                value: transaction.value,
                gasLimit: 500000 
            });
            
            await txResponse.wait();
            successCount++;
            
        } catch (e) {
            console.error(`Swap failed for ${token.symbol}:`, e.message);
        }
    }
    return successCount;
}

// =================================================================================
// --- WEB SOCKET SERVER ---
// =================================================================================
const wss = new WebSocket.Server({ port: config.port });
console.log(`WebSocket server started on port ${config.port}...`);
loadSettings();
loadTransactions();
loadEpochHistory();

wss.on('connection', ws => {
    console.log('Client connected.');

    
    const uiConfig = {
        ...autovoterConfig,
        hasWallet: !!autovoterConfig.signer, 
        privateKey: "" 
    };

ws.send(JSON.stringify({ type: 'autovoter_config_status', data: getSafeConfig() }));
    ws.send(JSON.stringify({ type: 'epoch_history_update', data: epochHistory }));

    ws.on('close', () => console.log('Client disconnected.'));
ws.on('error', (err) => console.error('WebSocket error:', err.message));

    ws.on('message', async (message) => {
        try {
            const parsed = JSON.parse(message);
            const bigIntReplacer = (key, value) => typeof value === 'bigint' ? value.toString() : value;

         const saveCurrentSettings = () => {
    try {
        const { signer, privateKey, ...settingsToSave } = autovoterConfig;
        
        fs.writeFileSync(settingsFilePath, JSON.stringify(settingsToSave, null, 2), 'utf8');
        console.log("UI Settings saved to settings.json (Private Key excluded)");
    } catch (error) {
        console.error("Error saving settings:", error);
    }
};

if (parsed.type === 'save_settings') {
    const { privateKey, tokenId, votePercentage, scanMode, rpcUrl, batchSize, fetchDelayMs } = parsed.data; 

    try {
        const percent = parseFloat(votePercentage);
        if (isNaN(percent) || percent < 0 || percent > 100) throw new Error("Invalid percentage.");       
        
        if (privateKey && privateKey.trim() !== "") {
            try {
                const wallet = new ethers.Wallet(privateKey, provider);
                autovoterConfig.signer = wallet;
                
                updateEnvFile('PRIVATE_KEY', privateKey);
                
                console.log(`Private Key updated in .env for address: ${wallet.address}`);
            } catch (e) {
                throw new Error("Invalid Private Key format.");
            }
        }

        if (rpcUrl && rpcUrl !== autovoterConfig.rpcUrl) {
            autovoterConfig.rpcUrl = rpcUrl;
            initBlockchain(rpcUrl);
        }

        autovoterConfig.batchSize = parseInt(batchSize) || 7;
        autovoterConfig.fetchDelayMs = parseInt(fetchDelayMs) || 1000;

        const ids = tokenId.toString().split(',').map(id => id.trim()).filter(id => id !== '');
        autovoterConfig.tokenIds = ids; 
        autovoterConfig.tokenId = ids.length > 0 ? ids[0] : null; 
        autovoterConfig.votePercentage = percent;
        autovoterConfig.scanMode = scanMode || 'scheduled';

        saveCurrentSettings(); 
        
        ws.send(JSON.stringify({ 
            type: 'settings_response', 
            success: true, 
            message: "Settings updated! (Key stored in .env)" 
        }));

        broadcast({ type: 'autovoter_config_status', data: getSafeConfig() });

    } catch (e) {
        ws.send(JSON.stringify({ type: 'settings_response', success: false, message: e.message }));
    }
}	
           else if (parsed.type === 'toggle_auto_compound') {
                const { enabled, delayHours, targetToken } = parsed.data;

                if (compoundIntervalTimer) {
                    clearInterval(compoundIntervalTimer);
                    compoundIntervalTimer = null;
                }

                if (enabled) {
                    console.log(`AUTO-PILOT ACTIVATED: Triggering ${delayHours} hours after Epoch flip.`);
                    ws.send(JSON.stringify({ type: 'status', message: 'Auto-Pilot Activated' }));
                    
                    const runAutoSequence = async () => {
                        console.log("⏰ Auto-Pilot Triggered");
                        ws.send(JSON.stringify({ type: 'swap_status', message: '🚀 Auto-Pilot Running...' }));

                        try {
                            if (!autovoterConfig.signer) throw new Error("Wallet not configured in settings.");

                            try {
                                const tx = await performRebase(autovoterConfig.signer, autovoterConfig.tokenId);
                                if (tx) {
                                    await tx.wait();
                                    ws.send(JSON.stringify({ type: 'swap_status', message: '✅ Rebase Complete' }));
                                } else {
                                    console.log("No Rebase needed.");
                                }
                            } catch(e) { console.log("Rebase skip:", e.message); }

                            try {
                                const tx = await performClaimBribes(autovoterConfig.signer, autovoterConfig.tokenId, latestFetchedData.pools);
                                if (tx) {
                                    await tx.wait();
                                    ws.send(JSON.stringify({ type: 'swap_status', message: '✅ Rewards Claimed' }));
                                } else {
                                     console.log("No rewards to claim.");
                                     ws.send(JSON.stringify({ type: 'swap_status', message: 'No new rewards found. checking the wallet.' }));
                                }
                            } catch(e) { 
                                console.log("Claim skip:", e.message); 
                            }

                            const balances = await scanWalletBalances(autovoterConfig.signer.address);
                            if(balances.length > 0) {
                                ws.send(JSON.stringify({ type: 'swap_status', message: `Swapping ${balances.length} tokens...` }));
                                const count = await executeOdosSwap(balances, targetToken);
                                ws.send(JSON.stringify({ type: 'swap_status', message: `✅ Auto-Swap: ${count} tokens swapped.` }));
                            } else {
                                ws.send(JSON.stringify({ type: 'swap_status', message: 'No tokens found to swap.' }));
                            }

                            ws.send(JSON.stringify({ type: 'swap_status', message: `💤 Sleeping until next epoch flip...` }));

                        } catch (e) {
                            console.error("Auto-Pilot Error:", e);
                            ws.send(JSON.stringify({ type: 'swap_status', message: `⚠️ Error: ${e.message}` }));
                        }
                    };
                    
                    
                    const checkAndRunAutoPilot = async () => {
                        if (!latestFetchedData.summary.epochVoteEnd) return;
                        const now = Math.floor(Date.now() / 1000);
                        
                        
                        const currentEpochStart = latestFetchedData.summary.epochVoteEnd - 604800;
                        const executionTime = currentEpochStart + (parseFloat(delayHours) * 3600);

                        if (now >= executionTime) {
                            
                            if (!autovoterConfig.lastAutoPilotEpochEnd || autovoterConfig.lastAutoPilotEpochEnd < currentEpochStart) {
                                autovoterConfig.lastAutoPilotEpochEnd = currentEpochStart;
                                saveCurrentSettings(); 
                                await runAutoSequence();
                            }
                        }
                    };

                    checkAndRunAutoPilot();
                    compoundIntervalTimer = setInterval(checkAndRunAutoPilot, 60000); // Check time every 60s

                } else {
                    console.log("AUTO-PILOT STOPPED.");
                    ws.send(JSON.stringify({ type: 'swap_status', message: 'Auto-Pilot Stopped.' }));
                }
            }
            else if (parsed.type === 'cast_manual_vote') {
                const { votes } = parsed.data;
                try {
                    ws.send(JSON.stringify({ type: 'vote_status', success: true, message: "Processing manual vote..." }));
                    await executeManualVote(votes);
                    ws.send(JSON.stringify({ type: 'vote_status', success: true, message: "Manual vote successful!" }));
                } catch (e) {
                    ws.send(JSON.stringify({ type: 'vote_status', success: false, message: `Error: ${e.message}` }));
                }
            }
          else if (parsed.type === 'claim_rebase') {
                if (!autovoterConfig.signer || !autovoterConfig.tokenIds || autovoterConfig.tokenIds.length === 0) {
                    return ws.send(JSON.stringify({ type: 'rewards_tx_result', success: false, message: 'Configure Bot first.' }));
                }

                try {
                    const AERO_ADDRESS = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
                    const aeroPrice = latestFetchedData.prices[AERO_ADDRESS.toLowerCase()] || 0;
                    
                    const aeroContract = new ethers.Contract(AERO_ADDRESS, ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256)"], autovoterConfig.signer);
                    const distWithSigner = distributorContract.connect(autovoterConfig.signer);
                    const veNftWithSigner = veNftContract.connect(autovoterConfig.signer);

                    let totalClaimedUSD = 0;
                    let claimPerformed = false;

                    for (const id of autovoterConfig.tokenIds) {
                        const amountToClaim = await distributorContract.claimable(id);
                        if (amountToClaim > 0n) {
                            claimPerformed = true;
                            ws.send(JSON.stringify({ type: 'rewards_tx_result', success: true, message: `Claiming rebase for ID ${id}...` }));
                            
                            await (await distWithSigner.claim(id, { gasLimit: 500000 })).wait();

                            totalClaimedUSD += (parseFloat(ethers.formatEther(amountToClaim)) * aeroPrice);

                            const walletBalance = await aeroContract.balanceOf(autovoterConfig.signer.address);
                            if (walletBalance > 0n) {
                                await (await aeroContract.approve(config.veNftAddress, walletBalance)).wait();
                                await (await veNftWithSigner.increaseAmount(id, walletBalance)).wait();
                            }
                        }
                    }

                    if (claimPerformed) {
                        if (totalClaimedUSD > 0) await recordRealizedEarnings(totalClaimedUSD);
                        ws.send(JSON.stringify({ type: 'rewards_tx_result', success: true, message: `Successfully Claimed & Locked Rebases! ($${totalClaimedUSD.toFixed(2)})` }));
                    } else {
                        ws.send(JSON.stringify({ type: 'rewards_tx_result', success: false, message: 'Nothing to claim (Calculated 0).' }));
                    }
                } catch (e) {
                    ws.send(JSON.stringify({ type: 'rewards_tx_result', success: false, message: `Action Failed: ${e.message}` }));
                }
            }
          else if (parsed.type === 'claim_bribes') {
                if (!autovoterConfig.signer || !autovoterConfig.tokenIds || autovoterConfig.tokenIds.length === 0) {
                    return ws.send(JSON.stringify({ type: 'rewards_tx_result', success: false, message: 'Configure Bot first.' }));
                }

                try {
                    if (!latestFetchedData.pools || latestFetchedData.pools.length === 0) {
                        ws.send(JSON.stringify({ type: 'status', message: '⚠️ Fetching fresh pool data...' }));
                        const freshData = await fetchData();
                        if (freshData) {
                            latestFetchedData = freshData;
                        } else {
                            throw new Error("Failed to fetch pool data from blockchain.");
                        }
                    }

                    ws.send(JSON.stringify({ type: 'rewards_tx_result', success: true, message: '🔍 Scanning gauges for earned rewards...' }));

                    const bribeAddresses = [];
                    const bribeTokens = [];
                    const feeAddresses = [];
                    const feeTokens = [];
                    let totalRealizedUSD = 0;

                    const votedPools = [];
                    for (const pool of latestFetchedData.pools) {
                        let hasVote = false;
                        for (const id of autovoterConfig.tokenIds) {
                            try {
                                const voteWeight = await voterContract.votes(id, pool.address);
                                if (voteWeight > 0n) {
                                    hasVote = true; break;
                                }
                            } catch(e) {}
                        }
                        if (hasVote) votedPools.push(pool);
                    }
                    console.log(`🛡️ Smart Scan: Reduced ${latestFetchedData.pools.length} total pools to ${votedPools.length} voted pools.`);

                    for (const pool of votedPools) {
                        if (pool.feeAddress && pool.feeAddress !== ethers.ZeroAddress) {
                            const contract = new ethers.Contract(pool.feeAddress, abi.rewardContract, provider);
                            const tokensFound = [];
                            const potentialTokens = Object.keys(pool.fees);

                            for (const tAddr of potentialTokens) {
                                for (const tid of autovoterConfig.tokenIds) {
                                    try {
                                        const earned = await contract.earned(tAddr, tid);
                                        if (earned > 0n) {
                                            if (!tokensFound.includes(tAddr)) tokensFound.push(tAddr);
                                            
                                            const price = latestFetchedData.prices[tAddr.toLowerCase()] || 0;
                                            const decimals = pool.fees[tAddr.toLowerCase()]?.decimals || 18;
                                            totalRealizedUSD += (parseFloat(ethers.formatUnits(earned, decimals)) * price);
                                        }
                                    } catch (e) {}
                                }
                            }
                            if (tokensFound.length > 0) {
                                feeAddresses.push(pool.feeAddress);
                                feeTokens.push(tokensFound);
                            }
                        }

                        if (pool.bribeAddress && pool.bribeAddress !== ethers.ZeroAddress) {
                            const contract = new ethers.Contract(pool.bribeAddress, abi.rewardContract, provider);
                            const tokensFound = [];
                            const potentialTokens = Object.keys(pool.bribes);

                            for (const tAddr of potentialTokens) {
                                for (const tid of autovoterConfig.tokenIds) {
                                    try {
                                        const earned = await contract.earned(tAddr, tid);
                                        if (earned > 0n) {
                                            if (!tokensFound.includes(tAddr)) tokensFound.push(tAddr);

                                            const price = latestFetchedData.prices[tAddr.toLowerCase()] || 0;
                                            const decimals = pool.bribes[tAddr.toLowerCase()]?.decimals || 18;
                                            totalRealizedUSD += (parseFloat(ethers.formatUnits(earned, decimals)) * price);
                                        }
                                    } catch (e) {}
                                }
                            }
                            if (tokensFound.length > 0) {
                                bribeAddresses.push(pool.bribeAddress);
                                bribeTokens.push(tokensFound);
                            }
                        }
                    }

                    if (feeAddresses.length === 0 && bribeAddresses.length === 0) {
                        return ws.send(JSON.stringify({ type: 'rewards_tx_result', success: false, message: 'No rewards found in any voted gauges.' }));
                    }

                    const voterWithSigner = voterContract.connect(autovoterConfig.signer);
                    let resultMsg = "";

                    for (const id of autovoterConfig.tokenIds) {
                        ws.send(JSON.stringify({ type: 'rewards_tx_result', success: true, message: `Sending claim for ID ${id}...` }));

                        if (bribeAddresses.length > 0) {
                            const tx = await voterWithSigner.claimBribes(bribeAddresses, bribeTokens, id);
                            await tx.wait();
                            resultMsg += `ID ${id} Bribes `;
                        }

                        if (feeAddresses.length > 0) {
                            const tx = await voterWithSigner.claimFees(feeAddresses, feeTokens, id);
                            await tx.wait();
                            resultMsg += `ID ${id} Fees `;
                        }
                    }
if (totalRealizedUSD > 0) {
                        await recordRealizedEarnings(totalRealizedUSD);

                        const lastVoteTx = transactionHistory.find(tx => tx.type === 'Auto-Vote');
                        
                        if (lastVoteTx) {
                            console.log(`📝 Updating History: Changing Est. $${lastVoteTx.value.toFixed(2)} to Actual $${totalRealizedUSD.toFixed(2)}`);
                            
                            lastVoteTx.value = totalRealizedUSD; 
                            lastVoteTx.status = "Rewards Claimed"; 
                            
                            fs.writeFileSync(transactionsFilePath, JSON.stringify(transactionHistory, null, 2), 'utf8');
                            
                            const totalEarnings = transactionHistory.reduce((acc, tx) => acc + (tx.value || 0), 0);
                            broadcast({ type: 'transaction_update', data: { history: transactionHistory, totalEarnings } });
                        }
                    }
					

                    ws.send(JSON.stringify({ 
                        type: 'rewards_tx_result', 
                        success: true, 
                        message: `Successfully claimed $${totalRealizedUSD.toFixed(2)} (${resultMsg})` 
                    }));

                } catch (e) {
                    console.error("Manual Claim Error:", e);
                    ws.send(JSON.stringify({ 
                        type: 'rewards_tx_result', 
                        success: false, 
                        message: `Claim Failed: ${e.reason || e.message}` 
                    }));
                }
            }
           
            else if (parsed.type === 'scan_wallet_balances') {
                
                 const targetAddr = autovoterConfig.signer ? autovoterConfig.signer.address : "0x22f9790175ef4f549092C91123E0f7C339CC7D3D";
                 
                 ws.send(JSON.stringify({ type: 'swap_status', message: 'Scanning wallet tokens...' }));
                 const balances = await scanWalletBalances(targetAddr);
                 ws.send(JSON.stringify({ type: 'wallet_balances_result', data: balances }));
                 ws.send(JSON.stringify({ type: 'swap_status', message: `Found ${balances.length} tokens.` }));
            }
            
            else if (parsed.type === 'execute_odos_swap') {
                const { inputTokens, outputToken } = parsed.data;
                try {
                     if (!autovoterConfig.signer) throw new Error("Please configure wallet in settings first.");
                     ws.send(JSON.stringify({ type: 'swap_status', message: 'Starting Swap Process...' }));
                     
                     const swapsDone = await executeOdosSwap(inputTokens, outputToken);
                     
                     ws.send(JSON.stringify({ type: 'swap_status', message: `Swap Process Complete. Swapped ${swapsDone} tokens.` }));
                } catch(e) {
                    ws.send(JSON.stringify({ type: 'swap_status', message: `Swap Error: ${e.message}` }));
                }
            }
            else if (parsed.type === 'simulate_vote') {
                try {
                    const { tokenId, votePercentage } = parsed.data;
                    console.log(`Running simulation for Token ID: ${tokenId}`);
                    const results = await getProjectedVoteOutcome(tokenId, votePercentage);
                    ws.send(JSON.stringify({ type: 'simulation_result', success: true, data: results.slice(0, 10) }, bigIntReplacer));
                } catch (e) {
                    console.error("Simulation failed:", e.message);
                    ws.send(JSON.stringify({ type: 'simulation_result', success: false, message: e.message }));
                }
            } else if (parsed.type === 'fetch_venft_details') {
                try {
                     const { tokenId } = parsed.data; 
        const ids = tokenId.toString().split(',').map(s => s.trim()).filter(s => s);
        
        const totalPower = await getTotalVotingPower(ids);

        ws.send(JSON.stringify({
            type: 'venft_details_result', success: true,
            data: { 
                tokenId: ids.join(', '), 
                votingPower: ethers.formatEther(totalPower) 
            }
        }));
                } catch (e) {
                    ws.send(JSON.stringify({ type: 'venft_details_result', success: false, message: e.message }));
                }
            } else if (parsed.type === 'toggle_autovoter') {
                autovoterConfig.enabled = !autovoterConfig.enabled;
                saveCurrentSettings();
broadcast({ type: 'autovoter_config_status', data: getSafeConfig() });
            } else if (parsed.type === 'set_vote_strategy') {
                const { strategy, pools } = parsed.data;
                if (['single', 'diversified', 'optimized'].includes(strategy)) {
                    autovoterConfig.voteStrategy = strategy;
                }
                const numPools = parseInt(pools, 10);
                if (!isNaN(numPools) && numPools > 0) {
                    autovoterConfig.diversificationPools = numPools;
                }
                saveCurrentSettings();
broadcast({ type: 'autovoter_config_status', data: getSafeConfig() });
            } else if (parsed.type === 'trigger_test_vote') {
                const { poolAddress } = parsed.data;
                try {
                    await executeTestVote(poolAddress);
                    ws.send(JSON.stringify({ type: 'test_vote_response', success: true }));
                } catch (e) {
                    ws.send(JSON.stringify({ type: 'test_vote_response', success: false, message: e.message }));
                }
            } else if (parsed.type === 'get_transactions') {
                const totalEarnings = transactionHistory.reduce((acc, tx) => acc + (tx.value || 0), 0);
                let votingPower = "0";
                if (autovoterConfig.tokenId) {
                    try {
                        const currentTimestamp = Math.floor(Date.now() / 1000);
                        const vp = await veNftContract.balanceOfNFTAt(autovoterConfig.tokenId, currentTimestamp);
                        votingPower = ethers.formatEther(vp);
                    } catch (e) { }
                }

                ws.send(JSON.stringify({
                    type: 'transaction_update',
                    data: {
                        history: transactionHistory,
                        totalEarnings,
                        votingPower,
                        votePercentage: autovoterConfig.votePercentage
                    }
                }));
            }
        } catch (e) { console.error("Failed to parse message:", e); }
    });

    
    const bigIntReplacer = (key, value) => typeof value === 'bigint' ? value.toString() : value;

    if (latestFetchedData.summary.epochVoteEnd && latestFetchedData.summary.totalVotingPower) {
        ws.send(JSON.stringify({ type: 'summary', data: latestFetchedData.summary }, bigIntReplacer));
        ws.send(JSON.stringify({ type: 'pools', data: latestFetchedData.pools }, bigIntReplacer));
    }
    broadcast({ type: 'status', message: 'Connected. Ready for setup.' });
});
async function recordProjectedAPR(totalEstimatedValueUSD) {
    try {
        const currentTimestamp = Math.floor(Date.now() / 1000);
        const AERODROME_START = 1693353600;
        const epochDuration = 604800;
        const currentEpochId = Math.floor((currentTimestamp - AERODROME_START) / epochDuration);

        const AERO_ADDRESS = '0x940181a94A35A4569E4529A3CDfB74e38FD98631'.toLowerCase();
        const aeroPrice = latestFetchedData.prices[AERO_ADDRESS] || 0;

        let totalUserPower = 0;
        for (const id of autovoterConfig.tokenIds) {
            const power = await veNftContract.balanceOfNFTAt(id, currentTimestamp);
            totalUserPower += parseFloat(ethers.formatEther(power));
        }

        const totalPowerValueUsd = totalUserPower * aeroPrice;
        let projectedApr = 0;
        if (totalPowerValueUsd > 0) {
            projectedApr = (totalEstimatedValueUSD / totalPowerValueUsd) * 52 * 100;
        }

        if (!epochHistory[currentEpochId]) {
            epochHistory[currentEpochId] = { epochId: currentEpochId, indexApr: 0, userApr: 0, earnings: 0, timestamp: Date.now() };
        }

        epochHistory[currentEpochId].userApr = parseFloat(projectedApr.toFixed(2));
        
        saveEpochHistory();
        broadcast({ type: 'epoch_history_update', data: epochHistory });
    } catch (e) { console.error("Analysis Error:", e); }
}

function broadcast(dataObject) {
    const dataString = JSON.stringify(dataObject, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value
    );
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(dataString);
    });
}

// =================================================================================
// --- DATA FETCHING & HELPERS ---
// =================================================================================
async function getTotalVotingPower(tokenIds) {
    let total = 0n;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    for (const id of tokenIds) {
        try {
            const power = await veNftContract.balanceOfNFTAt(id, currentTimestamp);
            total += power;
        } catch (e) { console.error(`Error fetching power for ID ${id}`, e); }
    }
    return total;
}

async function getLivePrices(tokenAddresses) {
    if (!tokenAddresses || tokenAddresses.length === 0) return {};

    console.log(`Fetching live prices for ${tokenAddresses.length} tokens in batches...`);
    const prices = {};
    const chunkSize = 30;

    for (let i = 0; i < tokenAddresses.length; i += chunkSize) {
        const chunk = tokenAddresses.slice(i, i + chunkSize);
        const apiUrl = `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`;

        try {
            const response = await fetch(apiUrl);
            if (!response.ok) {
                console.warn(`DexScreener API call for a chunk failed with status: ${response.status}`);
                continue;
            }
            const data = await response.json();

            if (data.pairs) {
                data.pairs.forEach(pair => {
                    const address = pair.baseToken.address.toLowerCase();
                    if (pair.priceUsd) {
                        prices[address] = parseFloat(pair.priceUsd);
                    }
                });
            }
        } catch (error) {
            console.error(`Could not fetch a batch of live prices:`, error.message);
        }
        await sleep(200);
    }

    console.log(`Successfully fetched ${Object.keys(prices).length} of ${tokenAddresses.length} prices.`);
    return prices;
}

async function getPoolTVLs(poolAddresses) {
    if (!poolAddresses || poolAddresses.length === 0) return {};

    console.log(`Fetching TVL for ${poolAddresses.length} pools...`);
    const tvls = {};
    const chunkSize = 30;

    for (let i = 0; i < poolAddresses.length; i += chunkSize) {
        const chunk = poolAddresses.slice(i, i + chunkSize);
        const apiUrl = `https://api.dexscreener.com/latest/dex/pairs/base/${chunk.join(',')}`;

        try {
            const response = await fetch(apiUrl);
            if (!response.ok) {
                console.warn(`DexScreener pair API call for a chunk failed with status: ${response.status}`);
                continue;
            }
            const data = await response.json();
            if (data.pairs) {
                data.pairs.forEach(pair => {
                    if (pair.pairAddress && pair.liquidity?.usd) {
                        tvls[pair.pairAddress.toLowerCase()] = parseFloat(pair.liquidity.usd);
                    }
                });
            }
        } catch (error) {
            console.error(`Could not fetch a batch of TVLs:`, error.message);
        }
        await sleep(200);
    }
    console.log(`Successfully fetched ${Object.keys(tvls).length} TVLs.`);
    return tvls;
}

async function getTokenInfo(address, customProvider = null) {
    if (tokenInfoCache[address]) return tokenInfoCache[address];

    const maxRetries = 3;
    for (let i = 0; i < maxRetries; i++) {
        try {
            const p = customProvider || getNextProvider();
            const contract = new ethers.Contract(address, abi.erc20, p);
            const [symbol, decimals] = await Promise.all([contract.symbol(), contract.decimals()]);
            const result = { symbol, decimals: Number(decimals) };
            tokenInfoCache[address] = result;
            return result;
        } catch (e) {
            console.warn(`Attempt ${i + 1} failed to get token info for ${address}. Retrying...`);
            if (i < maxRetries - 1) await sleep(1000);
        }
    }

    console.error(`All attempts failed to get token info for ${address}.`);
    return { symbol: "UNKNOWN", decimals: 18 };
}

async function getPoolName(address, customProvider = null) {
    const maxRetries = 1;
    for (let i = 0; i < maxRetries; i++) {
        try {
            const p = customProvider || getNextProvider();
            const contract = new ethers.Contract(address, abi.pair, p);
            const [token0Addr, token1Addr] = await Promise.all([contract.token0(), contract.token1()]);
            const [token0, token1] = await Promise.all([getTokenInfo(token0Addr, p), getTokenInfo(token1Addr, p)]);
            return `${token0.symbol}/${token1.symbol}`;
        } catch (e) {
            console.warn(`Attempt ${i + 1} failed to get pool name for ${address}. Retrying...`);
            if (i < maxRetries - 1) await sleep(1000);
        }
    }

    console.error(`All attempts failed to get pool name for ${address}.`);
    return "Unknown Pool";
}


// =================================================================================
// --- DATA FETCHING (SMART SCANNABLE) ---
// =================================================================================

async function fetchData(specificPoolAddresses = null) {
    try {
        const currentTimestamp = Math.floor(Date.now() / 1000);
        
        const epochDuration = 60 * 60 * 24 * 7;
        let targetEpoch = Math.floor(currentTimestamp / epochDuration) * epochDuration;
        let prevEpoch = targetEpoch - epochDuration;

        const AERO_ADDRESS = '0x940181a94A35A4569E4529A3CDfB74e38FD98631'.toLowerCase();

        const[totalVotingPower, weeklyEmissions, epochVoteEnd, poolCountBigInt] = await Promise.all([
            voterContract.totalWeight(), 
            minterContract.weekly(),
            voterContract.epochVoteEnd(currentTimestamp), 
            voterContract.length()
        ]);

        let poolListToProcess =[];
        if (specificPoolAddresses && specificPoolAddresses.length > 0) {
            poolListToProcess = specificPoolAddresses; 
        } else {
            const poolCount = Number(poolCountBigInt);
            poolListToProcess = Array.from({length: poolCount}, (_, i) => i);
        }

        console.log(`Fetching data for ${poolListToProcess.length} pools...`);
        broadcast({ type: 'status', message: `Scanning ${poolListToProcess.length} pools...` });

        const allPoolData =[];
        let requiredTokenAddresses = new Set([AERO_ADDRESS]);
        
        const requestsPerRpc = 7;
        const activeProvidersCount = providers.length > 0 ? providers.length : 1;
        const batchSize = activeProvidersCount * requestsPerRpc; 

        for (let i = 0; i < poolListToProcess.length; i += batchSize) {
            const batchPromises =[];
            const endIndex = Math.min(i + batchSize, poolListToProcess.length);

            for (let j = i; j < endIndex; j++) {
                const p = providers.length > 0 ? providers[j % providers.length] : provider;

                batchPromises.push(
                    (async () => {
                        try {
                            const localVoterContract = new ethers.Contract(config.voterAddress, abi.voter, p);

                            let poolAddress;
                            if (specificPoolAddresses) {
                                poolAddress = poolListToProcess[j];
                            } else {
                                poolAddress = await localVoterContract.pools(poolListToProcess[j]);
                            }

                            const gaugeAddress = await localVoterContract.gauges(poolAddress);
                            if (gaugeAddress === ethers.ZeroAddress) return null;
                            
                            const isGaugeAlive = await localVoterContract.isAlive(gaugeAddress);
                            if (!isGaugeAlive) return null;

                            const votingPower = await localVoterContract.weights(poolAddress);
                            
                            const name = await getPoolName(poolAddress, p); 
                            
                            const[feeAddr, bribeAddr] = await Promise.all([
                                localVoterContract.gaugeToFees(gaugeAddress), 
                                localVoterContract.gaugeToBribe(gaugeAddress)
                            ]);
                            
                            const poolInfo = { 
                                address: poolAddress, 
                                name: name, 
                                votingPower, 
                                fees: {}, 
                                bribes: {}, 
                                feeAddress: feeAddr, 
                                bribeAddress: bribeAddr 
                            };

                            const processRewards = async (contractAddress, rewardType) => {
                                if (contractAddress === ethers.ZeroAddress) return;
                                try {
                                    const contract = new ethers.Contract(contractAddress, abi.rewardContract, p);
                                    const rewardsCount = await contract.rewardsListLength();
                                    const limit = Number(rewardsCount) > 10 ? 10 : Number(rewardsCount);

                                    for (let k = 0; k < limit; k++) {
                                        const tokenAddress = await contract.rewards(k);
                                        const[amountCurrent, amountPrev] = await Promise.all([
                                            contract.tokenRewardsPerEpoch(tokenAddress, targetEpoch),
                                            contract.tokenRewardsPerEpoch(tokenAddress, prevEpoch)
                                        ]);

                                        const totalAmount = amountCurrent + amountPrev;                                                                           
                                        
                                        if (totalAmount > 0n || rewardType === "fees") {
                                            const { symbol, decimals } = await getTokenInfo(tokenAddress, p); 
                                            poolInfo[rewardType][tokenAddress.toLowerCase()] = { amount: totalAmount, decimals, symbol };
                                            requiredTokenAddresses.add(tokenAddress.toLowerCase());
                                            knownTokenAddresses.add(tokenAddress); 
                                        }
                                    }
                                } catch (e) { }
                            };
                            
                            await Promise.all([processRewards(feeAddr, "fees"), processRewards(bribeAddr, "bribes")]);
                            return poolInfo;
                        } catch (e) { return null; }
                    })()
                );
            }
            
            const batchResults = await Promise.all(batchPromises);
            batchResults.forEach(pool => { if (pool) allPoolData.push(pool); });
            
            broadcast({ 
                type: 'scanning_progress', 
                data: { scanned: endIndex, total: poolListToProcess.length, active: allPoolData.length } 
            });

            console.log(`Scanning... [${endIndex}/${poolListToProcess.length}] | ${allPoolData.length} active pools found.`);
            
            await sleep(autovoterConfig.fetchDelayMs || 1200);
        }

        const poolAddresses = allPoolData.map(p => p.address);
        const [prices, tvls] = await Promise.all([
            getLivePrices(Array.from(requiredTokenAddresses)),
            getPoolTVLs(poolAddresses)
        ]);
        const aeroPrice = prices[AERO_ADDRESS] || 0;

        const finalPools =[];
        let totalFeesUSD = 0, totalBribesUSD = 0;

        for (const pool of allPoolData) {
            const calculateValue = (rewards) => Object.entries(rewards).reduce((total,[address, { amount, decimals }]) => {
                const price = prices[address] || 0;
                return total + (Number(ethers.formatUnits(amount, decimals)) * price);
            }, 0);

            pool.totalFeesUSD = calculateValue(pool.fees);
            pool.totalBribesUSD = calculateValue(pool.bribes);
            pool.tvl = tvls[pool.address.toLowerCase()] || 0;

            const votingPowerUSD = Number(ethers.formatEther(pool.votingPower)) * aeroPrice;
            totalFeesUSD += pool.totalFeesUSD;
            totalBribesUSD += pool.totalBribesUSD;

            const voteShare = totalVotingPower > 0n ? Number(pool.votingPower * 1000000n / totalVotingPower) / 1000000 : 0;
            const weeklyEmissionsEther = ethers.formatEther(weeklyEmissions);

            pool.emissionsShare = Number(weeklyEmissionsEther) * voteShare;
            pool.emissionsUSD = pool.emissionsShare * aeroPrice;

            const totalRewardsUSD = pool.totalFeesUSD + pool.totalBribesUSD;
            pool.totalAPR = (votingPowerUSD > 1) ? (totalRewardsUSD / votingPowerUSD) * 52 * 100 : 0;
            pool.votesFmt = parseFloat(ethers.formatEther(pool.votingPower)).toLocaleString('en-US', { maximumFractionDigits: 0 });

            finalPools.push(pool);
        }

        const summaryData = {
            totalVotingPower: ethers.formatEther(totalVotingPower),
            weeklyEmissions: ethers.formatEther(weeklyEmissions),
            epochVoteEnd: Number(epochVoteEnd),
            totalFees: totalFeesUSD,
            totalIncentives: totalBribesUSD,
            totalRewards: totalFeesUSD + totalBribesUSD + (Number(ethers.formatEther(weeklyEmissions)) * aeroPrice),
            totalVotablePools: Number(poolCountBigInt),
            activeVotablePools: finalPools.length
        };

        return { pools: finalPools, summary: summaryData, prices };
    } catch (error) {
        console.error("Error fetching data:", error);
        broadcast({ type: 'error', message: 'Fetch failed. Retrying...' });
        return null;
    }
}
// =================================================================================
// --- HELPER FUNCTIONS FOR AUTO-PILOT ---
// =================================================================================
async function performRebase(signer, tokenIds) {
    const AERO_ADDRESS = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
    console.log("Starting Rebase Sequence...");
    
    const ids = Array.isArray(tokenIds) ? tokenIds : [tokenIds];
    const distributorWithSigner = distributorContract.connect(signer);
    const veNftWithSigner = veNftContract.connect(signer);
    const aeroContract = new ethers.Contract(AERO_ADDRESS, [
        "function balanceOf(address) view returns (uint256)", 
        "function approve(address,uint256) external"
    ], signer);

    let lastTx = null;
    let totalRebaseUsd = 0;
    const aeroPrice = latestFetchedData.prices[AERO_ADDRESS.toLowerCase()] || 0;

    for (const id of ids) {
        try {
            const amountToClaim = await distributorContract.claimable(id);
            
            if (amountToClaim > 0n) {
                broadcast({ type: 'swap_status', message: `Claiming Rebase for ID ${id}...` });
                const claimTx = await distributorWithSigner.claim(id, { gasLimit: 500000 });
                await claimTx.wait();
                
                totalRebaseUsd += (parseFloat(ethers.formatEther(amountToClaim)) * aeroPrice);

                const walletBalance = await aeroContract.balanceOf(signer.address);
                if (walletBalance > 0n) {
                    const approveTx = await aeroContract.approve(config.veNftAddress, walletBalance);
                    await approveTx.wait();
                    const lockTx = await veNftWithSigner.increaseAmount(id, walletBalance);
                    lastTx = lockTx; 
                    await lockTx.wait();
                }
            }
        } catch (e) {
            console.error(`Rebase failed for ID ${id}:`, e.message);
        }
    }

    if (totalRebaseUsd > 0) {
        console.log(`📈 Rebase profit added to analysis: $${totalRebaseUsd.toFixed(2)}`);
        await recordRealizedEarnings(totalRebaseUsd);
    }

    return lastTx; 
}

// =================================================================================
// --- AUTO-PILOT REWARDS CLAIMING ---
// =================================================================================
async function performClaimBribes(signer, tokenIds, pools) {
    console.log("--------------------------------------------------");
    console.log("🚀 AUTO-PILOT: Starting Reward Claim Sequence...");
    
    if (!pools || pools.length === 0) {
        console.log("⚠️ Pool data missing for claim. Attempting emergency scan...");
        const fresh = await fetchData();
        if (fresh) pools = fresh.pools;
        else {
            console.error("❌ Aborting claim: Could not fetch pool data.");
            return null;
        }
    }

    const ids = Array.isArray(tokenIds) ? tokenIds : [tokenIds];
    const votedPools = [];
for (const pool of pools) {
        let hasVote = false;
        for (const id of ids) {
            try {
                const voteWeight = await voterContract.votes(id, pool.address);
                if (voteWeight > 0n) {
                    hasVote = true; break;
                }
            } catch(e) {}
        }
        if (hasVote) votedPools.push(pool);
    }
    console.log(`🛡️ Auto-Pilot Scan: Reduced ${pools.length} total pools to ${votedPools.length} voted pools.`);
    const voterWithSigner = voterContract.connect(signer);
    
    let lastTx = null;
    let totalUsdRealizedAcrossAllNfts = 0;

    for (const id of ids) {
        try {
            console.log(`🔍 Scanning Rewards for Token ID: ${id}...`);
            broadcast({ type: 'swap_status', message: `Scanning rewards for ID ${id}...` });

            const bribeAddresses =[];
            const bribeTokens = [];
            const feeAddresses = [];
            const feeTokens =[];            

            for (const pool of pools) {
                
                if (pool.feeAddress && pool.feeAddress !== ethers.ZeroAddress) {
                    const contract = new ethers.Contract(pool.feeAddress, abi.rewardContract, getNextProvider());
                    const tokensFound =[];                   
                    const potentialTokens = Object.keys(pool.fees);
                    
                    for (const tokenAddr of potentialTokens) {
                        try {
                            const earned = await contract.earned(tokenAddr, id);
                            if (earned > 0n) {
                                tokensFound.push(tokenAddr);
                                
                                const price = latestFetchedData.prices[tokenAddr.toLowerCase()] || 0;
                                const decimals = pool.fees[tokenAddr.toLowerCase()]?.decimals || 18;
                                const usdValue = (parseFloat(ethers.formatUnits(earned, decimals)) * price);
                                totalUsdRealizedAcrossAllNfts += usdValue;
                                
                                console.log(`   ✨ Found Fee: ${pool.name} (${pool.fees[tokenAddr.toLowerCase()]?.symbol}) - Value: $${usdValue.toFixed(2)}`);
                            }
                        } catch(e) {}
                    }
                    if (tokensFound.length > 0) {
                        feeAddresses.push(pool.feeAddress);
                        feeTokens.push(tokensFound);
                    }
                }


                if (pool.bribeAddress && pool.bribeAddress !== ethers.ZeroAddress) {
                    const contract = new ethers.Contract(pool.bribeAddress, abi.rewardContract, getNextProvider());
                    const tokensFound =[];
                    const potentialTokens = Object.keys(pool.bribes);

                    for (const tokenAddr of potentialTokens) {
                        try {
                            const earned = await contract.earned(tokenAddr, id);
                            if (earned > 0n) {
                                tokensFound.push(tokenAddr);
                                
                                const price = latestFetchedData.prices[tokenAddr.toLowerCase()] || 0;
                                const decimals = pool.bribes[tokenAddr.toLowerCase()]?.decimals || 18;
                                const usdValue = (parseFloat(ethers.formatUnits(earned, decimals)) * price);
                                totalUsdRealizedAcrossAllNfts += usdValue;

                                console.log(`   ✨ Found Bribe: ${pool.name} (${pool.bribes[tokenAddr.toLowerCase()]?.symbol}) - Value: $${usdValue.toFixed(2)}`);
                            }
                        } catch(e) {}
                    }
                    if (tokensFound.length > 0) {
                        bribeAddresses.push(pool.bribeAddress);
                        bribeTokens.push(tokensFound);
                    }
                }
            }

            if (bribeAddresses.length > 0) {
                console.log(`📡 Sending Bribe Claim Tx for ID ${id}...`);
                broadcast({ type: 'swap_status', message: `Claiming Bribes for ID ${id}...` });
                const tx = await voterWithSigner.claimBribes(bribeAddresses, bribeTokens, id);
                lastTx = tx;
                await tx.wait();
                console.log(`✅ Bribe Claim Confirmed: ${tx.hash}`);
            }

            if (feeAddresses.length > 0) {
                console.log(`📡 Sending Fee Claim Tx for ID ${id}...`);
                broadcast({ type: 'swap_status', message: `Claiming Fees for ID ${id}...` });
                const tx = await voterWithSigner.claimFees(feeAddresses, feeTokens, id);
                lastTx = tx;
                await tx.wait();
                console.log(`✅ Fee Claim Confirmed: ${tx.hash}`);
            }

        } catch (e) {
            console.error(`❌ Claim failed for Token ID ${id}:`, e.message);
            broadcast({ type: 'swap_status', message: `Claim Error ID ${id}: ${e.message}` });
        }
    }

   if (totalUsdRealizedAcrossAllNfts > 0) {
        console.log(`💰 Total Realized across all NFTs: $${totalUsdRealizedAcrossAllNfts.toFixed(2)}`);
        
        await recordRealizedEarnings(totalUsdRealizedAcrossAllNfts);

        const lastVoteTx = transactionHistory.find(tx => tx.type === 'Auto-Vote');
        
        if (lastVoteTx) {
            console.log(`📝 Updating History: Changing Est. $${lastVoteTx.value.toFixed(2)} to Actual $${totalUsdRealizedAcrossAllNfts.toFixed(2)}`);
            
            lastVoteTx.value = totalUsdRealizedAcrossAllNfts;
            lastVoteTx.status = "Rewards Claimed"; 
            
            fs.writeFileSync(transactionsFilePath, JSON.stringify(transactionHistory, null, 2), 'utf8');
            
            const totalEarnings = transactionHistory.reduce((acc, tx) => acc + (tx.value || 0), 0);
            broadcast({ type: 'transaction_update', data: { history: transactionHistory, totalEarnings } });
        }
    }

    console.log("--------------------------------------------------");
    return lastTx;
}

// =================================================================================
// --- ENGINE 1: THE SNIPER (Checks Time & Executes Vote) ---
// =================================================================================
let sniperInterval = null;

function initSniper() {
    if (sniperInterval) clearInterval(sniperInterval);
    console.log("🔫 Sniper Engine Armed.");

    sniperInterval = setInterval(async () => {
        if (!autovoterConfig.enabled || !latestFetchedData.summary.epochVoteEnd) return;

        const now = Math.floor(Date.now() / 1000);
        const epochEnd = latestFetchedData.summary.epochVoteEnd;
        const timeRemaining = epochEnd - now;
        const voteLeadTime = config.voteLeadTime || 60; 

        const currentEpochStart = epochEnd - (7 * 24 * 60 * 60);

        if (timeRemaining > 0 && timeRemaining <= voteLeadTime) {
            if (lastEpochVoted !== currentEpochStart) {
                console.log(`⚡ SNIPER TRIGGERED: ${timeRemaining}s remaining. Firing Vote!`);
                await executeVote();
            }
        }
    }, 5000);
}
function updateEnvFile(key, value) {
    const envPath = './.env';
    let envContent = '';
    
    if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf8');
    }

    const newEntry = `${key}=${value}`;
    const regex = new RegExp(`^${key}=.*`, 'm');

    if (regex.test(envContent)) {
        envContent = envContent.replace(regex, newEntry);
    } else {
        envContent += `\n${newEntry}`;
    }

    fs.writeFileSync(envPath, envContent.trim() + '\n');
    process.env[key] = value;
}
// =================================================================================
// --- ENGINE 2: THE SMART SCANNER (Full Discovery -> Targeted Updates) ---
// =================================================================================
async function startContinuousScanner() {
    if (isLoopRunning) {
        console.log("⚠️ Scanner Engine is already running.");
        return;
    }
    isLoopRunning = true;

    console.log("🔄 Smart Scanner Engine Started.");
    initSniper();

    let prioritizedPoolAddresses = null; 

    while (true) {
        try {
            if (autovoterConfig.scanMode === 'scheduled') {
                const now = Math.floor(Date.now() / 1000);
                
                if (!latestFetchedData.summary || !latestFetchedData.summary.epochVoteEnd) {
                    try {
                        console.log("⏳ Cold Start: Syncing Epoch Timer...");
                        const epochEndBigInt = await voterContract.epochVoteEnd(now);
                        let epochEnd = Number(epochEndBigInt);
                        
                        if (!latestFetchedData.summary) latestFetchedData.summary = {};
                        latestFetchedData.summary.epochVoteEnd = epochEnd;
                        console.log(`✅ Synced! Epoch Ends: ${new Date(epochEnd * 1000).toLocaleString()}`);
                    } catch (e) {
                        console.log("⚠️ Sync failed. Will try Full Scan.");
                    }
                }

                if (latestFetchedData.summary && latestFetchedData.summary.epochVoteEnd) {
                    let epochEnd = latestFetchedData.summary.epochVoteEnd;
                    let timeRemaining = epochEnd - now;

                    
                    if (timeRemaining <= 0) {
                        console.log("ℹ️ Current Epoch has passed. Switching target to NEXT Epoch.");
                        epochEnd += (7 * 24 * 60 * 60); 
                        latestFetchedData.summary.epochVoteEnd = epochEnd; 
                        timeRemaining = epochEnd - now; 
                        console.log(`📅 New Target: ${new Date(epochEnd * 1000).toLocaleString()}`);
                    }
                    

                    const WAKE_UP_WINDOW = 1200; 

                    if (timeRemaining > WAKE_UP_WINDOW) {
    const minsToWait = Math.floor((timeRemaining - WAKE_UP_WINDOW) / 60);
    const hoursToWait = (minsToWait / 60).toFixed(1);
        if (Date.now() % 60000 < 5000) { 
        console.log(`[Scheduled Mode] 💤 Standing by. Wake up in ~${hoursToWait} hours.`);
    }
    
    broadcast({ type: 'status', message: `Scheduled Mode: Sleeping (${hoursToWait}h until scan)...` });
    
    await sleep(7000); 
    continue; 
                    } else {
                        console.log(`⏰ Scheduled Mode: WAKE UP! Inside the 15m window.`);
                    }
                }
            }

            const isFullScan = (prioritizedPoolAddresses === null);
            
            if (isFullScan) {
                console.log(`\n[${new Date().toLocaleTimeString()}] 🌍 STARTING FULL DISCOVERY SCAN...`);
            } else {
                console.log(`\n[${new Date().toLocaleTimeString()}] 🎯 STARTING TARGETED SCAN...`);
            }
            
            isFetching = true;
            const fetchedData = await fetchData(prioritizedPoolAddresses);
            isFetching = false;
            
            if (fetchedData && fetchedData.pools.length > 0) {
                latestFetchedData = fetchedData;
                
                broadcast({ type: 'summary', data: fetchedData.summary });
                broadcast({ type: 'pools', data: fetchedData.pools });
                broadcast({ type: 'status', message: isFullScan ? 'Full Scan Complete' : 'Targeted Update Complete' });
                
                if (isFullScan) {
                    const sorted = [...fetchedData.pools].sort((a, b) => {
                        const rewardsA = a.totalFeesUSD + a.totalBribesUSD;
                        const rewardsB = b.totalFeesUSD + b.totalBribesUSD;
                        return rewardsB - rewardsA;
                    });

                    const topPools = sorted.slice(0, 60);
                    prioritizedPoolAddresses = topPools.map(p => p.address);
                }
                trackEpochPerformance(fetchedData.summary, fetchedData.pools).catch(e => {});
            } else {
                prioritizedPoolAddresses = null; 
            }

        } catch (error) {
            console.error("❌ Scanner crashed (likely RPC limit). Pause for 10s...", error.message);
            isFetching = false;
            await sleep(10000); 
        }

if (autovoterConfig.scanMode === 'immediate') {
        const mins = config.fetchInterval / 60000;
        console.log(`[Immediate Mode] Scan complete. Sleeping for ${mins} minutes...`);
        await sleep(config.fetchInterval); 
    } else {
        await sleep(5000); 
    }
    }
}
// =================================================================================
// --- INITIALIZATION ---
// =================================================================================

loadSettings(); 
loadTransactions();
loadEpochHistory();
startContinuousScanner();
