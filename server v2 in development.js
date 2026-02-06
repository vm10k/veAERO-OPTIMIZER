const { ethers } = require("ethers");
const WebSocket = require('ws');
const fs = require('fs');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// =================================================================================
// --- SERVER CONFIGURATION & CONSTANTS ---
// =================================================================================
const config = {
    port: 3000,
    rpcUrl: "https://base.meowrpc.com",
    voteLeadTime: 60, 
    fetchInterval: 300000, 
    voterAddress: "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5",
    minterAddress: "0xeb018363f0a9af8f91f06fee6613a751b2a33fe5",
    distributorAddress: "0x227f65131A261548b057215bB1D5Ab2997964C7d",
    veNftAddress: "0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4" 
};
const provider = new ethers.JsonRpcProvider(config.rpcUrl);
const settingsFilePath = './settings.json';
const transactionsFilePath = './transactions.json';
const epochsFilePath = './epochs.json';

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

const voterContract = new ethers.Contract(config.voterAddress, abi.voter, provider);
const minterContract = new ethers.Contract(config.minterAddress, abi.minter, provider);
const veNftContract = new ethers.Contract(config.veNftAddress, abi.veNft, provider);
const distributorContract = new ethers.Contract(config.distributorAddress, abi.distributor, provider);
const tokenInfoCache = {};

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
	scanMode: 'scheduled' 
};
let isLoopRunning = false;

function loadSettings() {
    try {
        if (fs.existsSync(settingsFilePath)) {
            const data = fs.readFileSync(settingsFilePath, 'utf8');
            const savedSettings = JSON.parse(data);
            
            autovoterConfig.tokenId = savedSettings.tokenId || null;
            autovoterConfig.tokenIds = savedSettings.tokenIds || []; 
            autovoterConfig.votePercentage = savedSettings.votePercentage || 100;
            autovoterConfig.enabled = savedSettings.enabled || false;
            autovoterConfig.voteStrategy = savedSettings.voteStrategy || 'optimized';
            autovoterConfig.diversificationPools = savedSettings.diversificationPools || 3;
			autovoterConfig.scanMode = savedSettings.scanMode || 'scheduled'; 
            
            if (savedSettings.privateKey) {
                try {
                    autovoterConfig.privateKey = savedSettings.privateKey;
                    autovoterConfig.signer = new ethers.Wallet(savedSettings.privateKey, provider);
                    console.log(`Restored wallet session: ${autovoterConfig.signer.address}`);
                    
                    
                    if (!autovoterConfig.tokenIds.length && autovoterConfig.tokenId) {
                        autovoterConfig.tokenIds = [autovoterConfig.tokenId];
                    }
                } catch (e) {
                    console.error("Failed to restore wallet from saved private key:", e.message);
                }
            }
            

            console.log("Loaded settings from settings.json");
        }
    } catch (error) {
        console.error("Could not load settings:", error);
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

    let indexApr = 0;
    const validPools = pools.filter(p => p.tvl >= 100000);
    const sortedPools = [...validPools].sort((a, b) => b.totalAPR - a.totalAPR);

    const top3 = sortedPools.slice(0, 3);
    if (top3.length > 0) {
        indexApr = top3.reduce((sum, p) => sum + p.totalAPR, 0) / top3.length;
    }

    let userApr = 0;
    let earningsThisEpoch = 0;
    let userPower = 0;

    if (autovoterConfig.tokenId) {
        try {
            const now = Math.floor(Date.now() / 1000);
            const rawPower = await veNftContract.balanceOfNFTAt(autovoterConfig.tokenId, now);
            userPower = parseFloat(ethers.formatEther(rawPower));
        } catch (e) { }
    }

    const epochStartTs = (summary.epochVoteEnd - epochDuration) * 1000;
    const epochEndTs = summary.epochVoteEnd * 1000;

    const epochTx = transactionHistory.filter(tx =>
        tx.timestamp >= epochStartTs &&
        tx.timestamp < epochEndTs &&
        (tx.status === 'Confirmed' || tx.status === 'Success')
    );

    earningsThisEpoch = epochTx.reduce((sum, tx) => sum + (tx.value || 0), 0);

    let uniquePools = new Set();
    epochTx.forEach(tx => {
        if (Array.isArray(tx.pools)) tx.pools.forEach(p => uniquePools.add(p));
        else uniquePools.add(tx.pools);
    });

    const AERO_ADDRESS = '0x940181a94A35A4569E4529A3CDfB74e38FD98631'.toLowerCase();
    const aeroPrice = latestFetchedData.prices[AERO_ADDRESS] || 0;
    const powerValueUsd = userPower * aeroPrice;

    if (powerValueUsd > 0 && earningsThisEpoch > 0) {
        userApr = (earningsThisEpoch / powerValueUsd) * 52 * 100;
    }

    epochHistory[currentEpochId] = {
        epochId: currentEpochId,
        indexApr: parseFloat(indexApr.toFixed(2)),
        userApr: parseFloat(userApr.toFixed(2)),
        earnings: parseFloat(earningsThisEpoch.toFixed(2)),
        poolsVoted: uniquePools.size,
        timestamp: Date.now()
    };

    saveEpochHistory();
    broadcast({ type: 'epoch_history_update', data: epochHistory });
}

// =================================================================================
// --- AUTO-VOTER LOGIC ---
// =================================================================================
async function getProjectedVoteOutcome(tokenId, votePercentage) {
    if (!tokenId || isNaN(parseFloat(votePercentage))) {
        throw new Error("Invalid token ID or vote percentage for simulation.");
    }
    if (!latestFetchedData.pools || latestFetchedData.pools.length === 0) {
        throw new Error("Pool data not yet available for simulation. Please wait for the initial scan to complete.");
    }

    const currentTimestamp = Math.floor(Date.now() / 1000);
    const userVotingPower = await veNftContract.balanceOfNFTAt(tokenId, currentTimestamp);

    if (userVotingPower === 0n) {
        throw new Error(`Token ID ${tokenId} has zero voting power.`);
    }

    const AERO_ADDRESS = '0x940181a94A35A4569E4529A3CDfB74e38FD98631'.toLowerCase();
    const aeroPrice = latestFetchedData.prices[AERO_ADDRESS] || 0;
    if (aeroPrice === 0) {
        throw new Error("AERO price is not available. Cannot run simulation.");
    }

    const percentageAsInteger = BigInt(Math.round(votePercentage * 100));
    const userVoteWeight = (userVotingPower * percentageAsInteger) / 10000n;
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

    console.log(`EXECUTE VOTE: Process started for ${autovoterConfig.tokenIds.length} NFTs.`);
    lastEpochVoted = currentEpochStart;

    try {
        broadcast({ type: 'autovoter_status', message: 'Analyzing pools for optimal strategy...' });

        
        const simulationId = autovoterConfig.tokenIds[0];
        const projection = await getProjectedVoteOutcome(simulationId, autovoterConfig.votePercentage);
        
        if (!projection || projection.length === 0) throw new Error("No pool data available to execute vote.");

        
        let poolsToVoteFor = [];
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
        let successfulHashes = [];

       
      const voterContractWithSigner = voterContract.connect(autovoterConfig.signer);
        const currentTimestamp = Math.floor(Date.now() / 1000);

        for (const tokenId of autovoterConfig.tokenIds) {
            try {
               
                const totalVotingPower = await veNftContract.balanceOfNFTAt(tokenId, currentTimestamp);
                
                if (totalVotingPower === 0n) {
                    console.log(`Skipping Token ID ${tokenId}: 0 Voting Power.`);
                    continue;
                }

               
                const usedVotingPower = (totalVotingPower * percentageAsInteger) / 10000n;
                const weightPerPool = usedVotingPower / BigInt(poolsToVoteFor.length);
                const weightDistribution = poolsToVoteFor.map(() => weightPerPool);
                const poolVoteAddresses = poolsToVoteFor.map(p => p.address);

                console.log(`Voting with Token ID ${tokenId}...`);
                const tx = await voterContractWithSigner.vote(tokenId, poolVoteAddresses, weightDistribution);
                
                broadcast({ type: 'autovoter_status', message: `Voting ID ${tokenId}: Tx Sent...` });
                await tx.wait();
                
               
                successfulHashes.push(tx.hash);
                console.log(`Confirmed vote for ID ${tokenId}. Hash: ${tx.hash}`);

            } catch (innerError) {
                console.error(`Failed to vote for Token ID ${tokenId}:`, innerError.message);
                broadcast({ type: 'autovoter_status', message: `Error voting ID ${tokenId}: ${innerError.shortMessage || innerError.message}` });
            }
        }

        
        broadcast({ type: 'autovoter_status', message: `SUCCESS! All votes processed.` });
        
   
        let finalHashLabel = 'Multiple-NFTs';
        if (successfulHashes.length === 1) finalHashLabel = successfulHashes[0];

        
        logTransaction('Auto-Vote', finalHashLabel, poolNames, totalEstimatedValue, 'Confirmed');
		
        await trackEpochPerformance(latestFetchedData.summary, latestFetchedData.pools);

    } catch (error) {
        console.error("VOTE EXECUTION FAILED:", error);
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
            const tokenContract = new ethers.Contract(tokenAddr, abi.erc20, provider);
            
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

    ws.send(JSON.stringify({ type: 'autovoter_config_status', data: uiConfig }));
	
    ws.send(JSON.stringify({ type: 'autovoter_config_status', data: autovoterConfig }));
    ws.send(JSON.stringify({ type: 'epoch_history_update', data: epochHistory }));

    ws.on('close', () => console.log('Client disconnected.'));

    ws.on('message', async (message) => {
        try {
            const parsed = JSON.parse(message);
            const bigIntReplacer = (key, value) => typeof value === 'bigint' ? value.toString() : value;

            const saveCurrentSettings = () => {
                try {
                    const { signer, ...settingsToSave } = autovoterConfig;
                    fs.writeFileSync(settingsFilePath, JSON.stringify(settingsToSave, null, 2), 'utf8');
                    console.log("Settings saved to settings.json");
                } catch (error) {
                    console.error("Error saving settings:", error);
                }
            };

if (parsed.type === 'save_settings') {
                const { privateKey, tokenId, votePercentage, scanMode } = parsed.data; 

                try {
                    const percent = parseFloat(votePercentage);
                    if (isNaN(percent) || percent < 0 || percent > 100) throw new Error("Invalid percentage.");

                    const wallet = privateKey ? new ethers.Wallet(privateKey, provider) : null;
                    
                    const ids = tokenId.toString().split(',').map(id => id.trim()).filter(id => id !== '');
                    
                    autovoterConfig.privateKey = privateKey;
                    autovoterConfig.signer = wallet;
                    autovoterConfig.tokenIds = ids; 
                    autovoterConfig.tokenId = ids.length > 0 ? ids[0] : null; 
                    autovoterConfig.votePercentage = percent;
                    
                    autovoterConfig.scanMode = scanMode || 'scheduled';

                    const statusMsg = ids.length > 0 
                        ? `Bot configured for ${ids.length} NFTs.` 
                        : `Bot configured in Watch-Only mode.`;

                    console.log(`${statusMsg} Mode: ${autovoterConfig.scanMode}`);
                    saveCurrentSettings(); 
                    
                    ws.send(JSON.stringify({ type: 'settings_response', success: true, message: `${statusMsg} Mode: ${autovoterConfig.scanMode}` }));

                } catch (e) {
                    autovoterConfig.signer = null;
                    const errorMessage = e.message.toLowerCase().includes("private key") ? 'Error: Invalid private key.' : `Error: ${e.message}`;
                    ws.send(JSON.stringify({ type: 'settings_response', success: false, message: errorMessage }));
                }
            }
			
            else if (parsed.type === 'toggle_auto_compound') {
                const { enabled, intervalHours, targetToken } = parsed.data;

               
                if (compoundIntervalTimer) {
                    clearInterval(compoundIntervalTimer);
                    compoundIntervalTimer = null;
                }

                if (enabled) {
                    console.log(`AUTO-PILOT ACTIVATED: Every ${intervalHours} hours.`);
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

                            ws.send(JSON.stringify({ type: 'swap_status', message: `💤 Sleeping for ${intervalHours} hours...` }));

                        } catch (e) {
                            console.error("Auto-Pilot Error:", e);
                            ws.send(JSON.stringify({ type: 'swap_status', message: `⚠️ Error: ${e.message}` }));
                        }
                    };
                    
                    runAutoSequence();

                    
                    const ms = parseFloat(intervalHours) * 60 * 60 * 1000;
                    compoundIntervalTimer = setInterval(runAutoSequence, ms);

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
                if (!autovoterConfig.signer || !autovoterConfig.tokenId) {
                    return ws.send(JSON.stringify({ type: 'rewards_tx_result', success: false, message: 'Configure Bot first.' }));
                }
                try {
                    
                    const AERO_ADDRESS = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
                    const aeroContract = new ethers.Contract(AERO_ADDRESS, ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256)"], provider);
                    
                   
                    const amountToClaim = await distributorContract.claimable(autovoterConfig.tokenId);
                    if (amountToClaim === 0n) {
                         return ws.send(JSON.stringify({ type: 'rewards_tx_result', success: false, message: 'Nothing to claim (Calculated 0).' }));
                    }

                   
                    const distributorBalance = await aeroContract.balanceOf(config.distributorAddress);
                    if (distributorBalance < amountToClaim) {
                        return ws.send(JSON.stringify({ 
                            type: 'rewards_tx_result', 
                            success: false, 
                            message: `Distribution Pending: Contract has insufficient AERO. Wait for Epoch distribution.` 
                        }));
                    }

                   
                    const distWithSigner = distributorContract.connect(autovoterConfig.signer);
                    ws.send(JSON.stringify({ type: 'rewards_tx_result', success: true, message: `Claiming ${ethers.formatEther(amountToClaim)} AERO...` }));
                    
                    
                    const claimTx = await distWithSigner.claim(autovoterConfig.tokenId, { gasLimit: 600000 });
                    await claimTx.wait();
                    
                   
                    ws.send(JSON.stringify({ type: 'rewards_tx_result', success: true, message: 'Claim Confirmed. Locking (Compounding)...' }));
                    
                    const aeroWithSigner = aeroContract.connect(autovoterConfig.signer);
                    const walletBalance = await aeroContract.balanceOf(autovoterConfig.signer.address);

                    if (walletBalance > 0n) {
                       
                        const approveTx = await aeroWithSigner.approve(config.veNftAddress, walletBalance);
                        await approveTx.wait();

                       
                        const veNftWithSigner = veNftContract.connect(autovoterConfig.signer);
                        const lockTx = await veNftWithSigner.increaseAmount(autovoterConfig.tokenId, walletBalance);
                        await lockTx.wait();
                        
                        ws.send(JSON.stringify({ type: 'rewards_tx_result', success: true, message: 'Rebase Successfully Claimed & Locked!' }));
                    } else {
                         ws.send(JSON.stringify({ type: 'rewards_tx_result', success: true, message: 'Claim successful' }));
                    }

                } catch (e) {
                    console.error("Rebase Error:", e);
                    ws.send(JSON.stringify({ type: 'rewards_tx_result', success: false, message: `Action Failed: ${e.reason || e.message}` }));
                }
            }
          else if (parsed.type === 'claim_bribes') {
                if (!autovoterConfig.signer || !autovoterConfig.tokenIds || autovoterConfig.tokenIds.length === 0) {
                    return ws.send(JSON.stringify({ type: 'rewards_tx_result', success: false, message: 'Configure Bot first.' }));
                }

                try {
                    if (!latestFetchedData.pools || latestFetchedData.pools.length === 0) {
                        ws.send(JSON.stringify({ type: 'status', message: '⚠️ Scheduled Mode: Waking up to scan pools for rewards...' }));
                        console.log("Force-scanning pools for manual claim...");
                        
                        const freshData = await fetchData();
                        if (freshData) {
                            latestFetchedData = freshData;
                            broadcast({ type: 'summary', data: latestFetchedData.summary });
                            broadcast({ type: 'pools', data: latestFetchedData.pools });
                        } else {
                            throw new Error("Failed to fetch pool data.");
                        }
                    }

                    ws.send(JSON.stringify({ type: 'rewards_tx_result', success: true, message: '🔍 Scanning your specific rewards...' }));

                    const bribeAddresses = [];
                    const bribeTokens = [];
                    const feeAddresses = [];
                    const feeTokens = [];

                    let foundAny = false;

                    for (const pool of latestFetchedData.pools) {
                        
                        if (pool.feeAddress && pool.feeAddress !== ethers.ZeroAddress && pool.fees) {
                            const contract = new ethers.Contract(pool.feeAddress, abi.rewardContract, provider);
                            const tokensToClaim = [];                   
                            const potentialTokens = Object.keys(pool.fees);
                            
                            for (const tokenAddr of potentialTokens) {
                                try {
                                    for(const tid of autovoterConfig.tokenIds) {
                                        const earned = await contract.earned(tokenAddr, tid);
                                        if (earned > 0n) {
                                            if(!tokensToClaim.includes(tokenAddr)) tokensToClaim.push(tokenAddr);
                                            console.log(`Found Fee: ${pool.name} -> ${tokenAddr}`);
                                            break; 
                                        }
                                    }
                                } catch(e) {}
                            }
                            if (tokensToClaim.length > 0) {
                                feeAddresses.push(pool.feeAddress);
                                feeTokens.push(tokensToClaim);
                                foundAny = true;
                            }
                        }

                        if (pool.bribeAddress && pool.bribeAddress !== ethers.ZeroAddress && pool.bribes) {
                            const contract = new ethers.Contract(pool.bribeAddress, abi.rewardContract, provider);
                            const tokensToClaim = [];
                            const potentialTokens = Object.keys(pool.bribes);

                            for (const tokenAddr of potentialTokens) {
                                try {
                                    for(const tid of autovoterConfig.tokenIds) {
                                        const earned = await contract.earned(tokenAddr, tid);
                                        if (earned > 0n) {
                                            if(!tokensToClaim.includes(tokenAddr)) tokensToClaim.push(tokenAddr);
                                            console.log(`Found Bribe: ${pool.name} -> ${tokenAddr}`);
                                            break; 
                                        }
                                    }
                                } catch(e) {}
                            }
                            if (tokensToClaim.length > 0) {
                                bribeAddresses.push(pool.bribeAddress);
                                bribeTokens.push(tokensToClaim);
                                foundAny = true;
                            }
                        }
                    }

                    if (!foundAny) {
                        return ws.send(JSON.stringify({ type: 'rewards_tx_result', success: false, message: 'Checked all pools: No rewards earned.' }));
                    }

                    const voterWithSigner = voterContract.connect(autovoterConfig.signer);
                    let resultMsg = "";

                    for (const id of autovoterConfig.tokenIds) {
                        ws.send(JSON.stringify({ type: 'rewards_tx_result', success: true, message: `Processing claims for Token ID ${id}...` }));

                        if (bribeAddresses.length > 0) {
                            try {
                                const tx = await voterWithSigner.claimBribes(bribeAddresses, bribeTokens, id);
                                await tx.wait();
                                resultMsg += `ID ${id} Bribes. `;
                            } catch(e) { console.log(`Bribe claim fail ID ${id}`); }
                        }

                        if (feeAddresses.length > 0) {
                            try {
                                const tx = await voterWithSigner.claimFees(feeAddresses, feeTokens, id);
                                await tx.wait();
                                resultMsg += `ID ${id} Fees. `;
                            } catch(e) { console.log(`Fee claim fail ID ${id}`); }
                        }
                    }

                    ws.send(JSON.stringify({ type: 'rewards_tx_result', success: true, message: `Success! ${resultMsg}` }));

                } catch (e) {
                    console.error("Claim Error:", e);
                    ws.send(JSON.stringify({ type: 'rewards_tx_result', success: false, message: `Claim Failed: ${e.reason || e.message}` }));
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
                broadcast({ type: 'autovoter_config_status', data: autovoterConfig });
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
                broadcast({ type: 'autovoter_config_status', data: autovoterConfig });
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

    
    if (latestFetchedData.summary.epochVoteEnd && latestFetchedData.summary.totalVotingPower) {
        ws.send(JSON.stringify({ type: 'summary', data: latestFetchedData.summary }));
        ws.send(JSON.stringify({ type: 'pools', data: latestFetchedData.pools }));
    }
    broadcast({ type: 'status', message: 'Connected. Ready for setup.' });
});

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

async function getTokenInfo(address) {
    if (tokenInfoCache[address]) return tokenInfoCache[address];

    const maxRetries = 3;
    for (let i = 0; i < maxRetries; i++) {
        try {
            const contract = new ethers.Contract(address, abi.erc20, provider);
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

async function getPoolName(address) {
    const maxRetries = 3;
    for (let i = 0; i < maxRetries; i++) {
        try {
            const contract = new ethers.Contract(address, abi.pair, provider);
            const [token0Addr, token1Addr] = await Promise.all([contract.token0(), contract.token1()]);
            const [token0, token1] = await Promise.all([getTokenInfo(token0Addr), getTokenInfo(token1Addr)]);
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

        
        const [totalVotingPower, weeklyEmissions, epochVoteEnd, poolCountBigInt] = await Promise.all([
            voterContract.totalWeight(), 
            minterContract.weekly(),
            voterContract.epochVoteEnd(currentTimestamp), 
            voterContract.length()
        ]);

        
        let poolListToProcess = [];
        if (specificPoolAddresses && specificPoolAddresses.length > 0) {
            poolListToProcess = specificPoolAddresses; 
        } else {
            
            const poolCount = Number(poolCountBigInt);
            poolListToProcess = Array.from({length: poolCount}, (_, i) => i);
        }

        console.log(`Fetching data for ${poolListToProcess.length} pools...`);
        broadcast({ type: 'status', message: `Scanning ${poolListToProcess.length} pools...` });

        const allPoolData = [];
        let requiredTokenAddresses = new Set([AERO_ADDRESS]);
        
        const batchSize = 7; 

        for (let i = 0; i < poolListToProcess.length; i += batchSize) {
            const batchPromises = [];
            const endIndex = Math.min(i + batchSize, poolListToProcess.length);

            for (let j = i; j < endIndex; j++) {
                batchPromises.push(
                    (async () => {
                        try {
                            let poolAddress;
                            
                            if (specificPoolAddresses) {
                                poolAddress = poolListToProcess[j];
                            } else {
                                poolAddress = await voterContract.pools(poolListToProcess[j]);
                            }

                            const gaugeAddress = await voterContract.gauges(poolAddress);
                            if (gaugeAddress === ethers.ZeroAddress) return null;
                            
                            const isGaugeAlive = await voterContract.isAlive(gaugeAddress);
                            if (!isGaugeAlive) return null;

                            const votingPower = await voterContract.weights(poolAddress);
                            const name = await getPoolName(poolAddress);
                            
                            const [feeAddr, bribeAddr] = await Promise.all([
                                voterContract.gaugeToFees(gaugeAddress), 
                                voterContract.gaugeToBribe(gaugeAddress)
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
                                    const contract = new ethers.Contract(contractAddress, abi.rewardContract, provider);
                                    const rewardsCount = await contract.rewardsListLength();
                                    const limit = Number(rewardsCount) > 10 ? 10 : Number(rewardsCount);

                                    for (let k = 0; k < limit; k++) {
                                        const tokenAddress = await contract.rewards(k);
                                        const [amountCurrent, amountPrev] = await Promise.all([
                                            contract.tokenRewardsPerEpoch(tokenAddress, targetEpoch),
                                            contract.tokenRewardsPerEpoch(tokenAddress, prevEpoch)
                                        ]);

                                        const totalAmount = amountCurrent + amountPrev;                                                                           
                                        
                                        if (totalAmount > 0n || rewardType === "fees") {
                                            const { symbol, decimals } = await getTokenInfo(tokenAddress);
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
            
            broadcast({ type: 'scanning_progress', data: { scanned: endIndex, total: poolListToProcess.length, active: allPoolData.length } });
            
            await sleep(specificPoolAddresses ? 100 : 1000); 
        }

        const poolAddresses = allPoolData.map(p => p.address);
        const [prices, tvls] = await Promise.all([
            getLivePrices(Array.from(requiredTokenAddresses)),
            getPoolTVLs(poolAddresses)
        ]);
        const aeroPrice = prices[AERO_ADDRESS] || 0;

        const finalPools = [];
        let totalFeesUSD = 0, totalBribesUSD = 0;

        for (const pool of allPoolData) {
            const calculateValue = (rewards) => Object.entries(rewards).reduce((total, [address, { amount, decimals }]) => {
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

    for (const id of ids) {
        try {
            console.log(`Checking Rebase for ID: ${id}`);
            
           
            const amountToClaim = await distributorContract.claimable(id);
            
            if (amountToClaim > 0n) {
               
                broadcast({ type: 'swap_status', message: `Claiming Rebase for ID ${id}...` });
                const claimTx = await distributorWithSigner.claim(id, { gasLimit: 500000 });
                await claimTx.wait();
                console.log(`Claimed ${ethers.formatEther(amountToClaim)} AERO for ID ${id}`);               
                const walletBalance = await aeroContract.balanceOf(signer.address);
                
                if (walletBalance > 0n) {
                    broadcast({ type: 'swap_status', message: `Compounding into ID ${id}...` });
                    
                   
                    const approveTx = await aeroContract.approve(config.veNftAddress, walletBalance);
                    await approveTx.wait();

                   
                    const lockTx = await veNftWithSigner.increaseAmount(id, walletBalance);
                    lastTx = lockTx; 
                    await lockTx.wait();
                    
                    console.log(`Compounded complete for ID ${id}`);
                }
            } else {
                console.log(`ID ${id}: Nothing to rebase.`);
            }
        } catch (e) {
            console.error(`Rebase failed for ID ${id}:`, e.message);
            broadcast({ type: 'swap_status', message: `Rebase Error ID ${id}: ${e.message}` });
        }
    }

    return lastTx; 
}

async function performClaimBribes(signer, tokenIds, pools) {
    console.log("Starting Reward Claim Sequence...");
    
    
    const ids = Array.isArray(tokenIds) ? tokenIds : [tokenIds];
    const voterWithSigner = voterContract.connect(signer);
    
    let lastTx = null;

    for (const id of ids) {
        try {
            console.log(`Scanning rewards for Token ID: ${id}...`);
            broadcast({ type: 'swap_status', message: `Scanning rewards for ID ${id}...` });

            const bribeAddresses = [];
            const bribeTokens = [];
            const feeAddresses = [];
            const feeTokens = [];            
            for (const pool of pools) {
                
               
                if (pool.feeAddress && pool.feeAddress !== ethers.ZeroAddress && pool.fees) {
                    const contract = new ethers.Contract(pool.feeAddress, abi.rewardContract, provider);
                    const tokensToClaim = [];                   
                    const potentialTokens = Object.keys(pool.fees);
                    
                    for (const tokenAddr of potentialTokens) {
                        try {
                            const earned = await contract.earned(tokenAddr, id);
                            if (earned > 0n) tokensToClaim.push(tokenAddr);
                        } catch(e) {}
                    }
                    if (tokensToClaim.length > 0) {
                        feeAddresses.push(pool.feeAddress);
                        feeTokens.push(tokensToClaim);
                    }
                }

               
                if (pool.bribeAddress && pool.bribeAddress !== ethers.ZeroAddress && pool.bribes) {
                    const contract = new ethers.Contract(pool.bribeAddress, abi.rewardContract, provider);
                    const tokensToClaim = [];
                    const potentialTokens = Object.keys(pool.bribes);

                    for (const tokenAddr of potentialTokens) {
                        try {
                            const earned = await contract.earned(tokenAddr, id);
                            if (earned > 0n) tokensToClaim.push(tokenAddr);
                        } catch(e) {}
                    }
                    if (tokensToClaim.length > 0) {
                        bribeAddresses.push(pool.bribeAddress);
                        bribeTokens.push(tokensToClaim);
                    }
                }
            }

            
            if (bribeAddresses.length === 0 && feeAddresses.length === 0) {
                console.log(`ID ${id}: No rewards found.`);
                continue;
            }

            
            if (bribeAddresses.length > 0) {
                console.log(`Claiming bribes from ${bribeAddresses.length} pools for ID ${id}...`);
                broadcast({ type: 'swap_status', message: `Claiming Bribes for ID ${id}...` });
                const tx = await voterWithSigner.claimBribes(bribeAddresses, bribeTokens, id);
                lastTx = tx;
                await tx.wait();
            }

            
            if (feeAddresses.length > 0) {
                console.log(`Claiming fees from ${feeAddresses.length} pools for ID ${id}...`);
                const tx = await voterWithSigner.claimFees(feeAddresses, feeTokens, id);
                lastTx = tx;
                await tx.wait();
            }
            
            console.log(`Rewards claimed for ID ${id}.`);

        } catch (e) {
            console.error(`Claim failed for ID ${id}:`, e.message);
            broadcast({ type: 'swap_status', message: `Claim Error ID ${id}: ${e.message}` });
        }
    }

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
                    

                    const WAKE_UP_WINDOW = 900; 

                    if (timeRemaining > WAKE_UP_WINDOW) {
                        const minsToWait = Math.floor((timeRemaining - WAKE_UP_WINDOW) / 60);
                        const hoursToWait = (minsToWait / 60).toFixed(1);
                        
                        console.log(`[Scheduled Mode] 💤 Standing by. Wake up in ~${hoursToWait} hours.`);
                        broadcast({ type: 'status', message: `Scheduled Mode: Sleeping (${hoursToWait}h until scan)...` });
                        
                        await sleep(60000); 
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
            console.error("❌ Scanner crashed:", error.message);
            isFetching = false;
            prioritizedPoolAddresses = null;
            await sleep(5000);
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