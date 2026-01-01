# veAERO Yield Optimizer (Self-Hosted Dashboard)
**Consider it aerodrome at home. // the voting page section but running locally with many other features**
<img width="1036" height="256" alt="veAERO Dashboard Interface" src="https://github.com/user-attachments/assets/48ba8a69-d58e-404c-ae7f-66e425e95d81" />

**veAERO Optimizer** is a local, open-source automation tool designed for **Aerodrome Finance** on the Base network. It manages your `veAERO` NFTs to maximize weekly voting yield through intelligent APR analysis, auto-voting strategies, and rewards compounding.

Unlike web-hosted dApps, this tool runs entirely on your local machine (`localhost`), ensuring complete control over your private keys and data.

## 🛡️ Security & Architecture (Why Local?)

In an era of frequent **DNS hijacks**, **frontend exploits**, and **phishing domains**, trusting a website with your wallet interaction is risky.

**veAERO Optimizer mitigates these risks by removing the "Web" from the equation:**

1.  **Local Execution:** The dashboard (`dashboard.html`) opens directly from your hard drive. The backend (`server.js`) runs on your machine.
2.  **Keys Stay Local:** Your private key is stored in a local file (`settings.json`) generated on your computer. It is **never** transmitted to any cloud server or API.
3.  **Direct RPC Connection:** The bot communicates directly with the Base blockchain nodes (RPC). There is no middleman API that can be compromised to feed you false data and better to get paid RPC for faster fetching by changing batchsize in server.js from 7 to 15.
4.  **Open Source:** The code is transparent. You can read exactly how the bot constructs transactions before you run it.

---

## 🚀 Key Features

*   **Real-Time APR Scanning:** Fetches live Bribe and Fee data from the blockchain to calculate the *actual* Voter APR (vAPR), not just estimated averages.
*   **Smart Auto-Voting:** Automatically casts votes for the highest yielding pools based on your chosen strategy.
*   **Inflation Protection (Rebase):** One-click or automated claiming of weekly rebases to grow your voting power and prevent dilution.
*   **Reward Aggregation:** Scans all pools for hidden Bribes and Trading Fees earned by your NFT.
*   **Integrated Odos Swap:** A built-in aggregator that scans your wallet for scattered reward tokens (USDC, WETH, DEGEN, etc.) and performs a batch swap to a single asset (like USDC) in one transaction.
*   **Performance Tracking:** A visual chart comparing your specific NFT's performance against the "Market Index" (Average of the Top 3 pools).

---

## 🛠️ Installation & Setup

### Prerequisites
*   [Node.js](https://nodejs.org/) (Version 16 or higher).
*   A wallet containing `veAERO` on the Base Network.

### Step-by-Step Guide

1.  **Download/Clone:**
    Download this repository to a folder on your computer.

2.  **Install Dependencies:**
    Open your terminal/command prompt in the project folder and run:
    ```bash
    npm install
    ```
    *This installs `ethers`, `ws` (WebSocket), and other necessary libraries.*

3.  **Start the Server:**
    Run the backend logic:
    ```bash
    node server.js
    ```
    *You will see a message: "WebSocket server started on port 3000..."*

4.  **Launch the Dashboard:**
    Double-click the `dashboard.html` file. It will open in your default browser and automatically connect to the server.

---

## 🖥️ Dashboard Tabs Explained

### 1. ℹ️ Info Tab
The landing page. It provides a quick connection status check and a simplified "How-To" guide for new users.

### 2. 🌊 Pools Tab (The Scanner)
This is the main data interface.
*   **Live Data:** Displays the current TVL, Votes, and Calculated vAPR for every active pool on Aerodrome.
*   **Filters & Sort:** Filter by "Most Rewarded" to see where the bribes are, or sort by "TVL" or "APR".
*   **Manual Picking:** Click the **"Pick Pool"** button on any card to add it to your "My Vote Card" sidebar.

### 3. 📈 Analysis Tab
Visualizes your historical performance.
*   **Performance Chart:** Tracks your specific APR vs. the Index APR (Top 3 pools average) epoch by epoch.
*   **Win Rate:** Shows the percentage of epochs where your strategy outperformed the general market.
*   **Strategy Insights:** Displays data on how diversified your votes have been historically.

### 4. 📜 Transactions Tab
An immutable log of the bot's actions.
*   **History:** Lists every Vote, Rebase Claim, and Reward Swap performed.
*   **Value:** Estimates the USD value of every transaction at the time it occurred.
*   **Status:** Shows confirmed/failed statuses with links to the Transaction Hash.

### 5. ⚙️ Settings Tab (Configuration)
The command center for the bot.
*   **Credentials:** Input your `veNFT ID` and (optionally) your Private Key for auto-voting.
*   **Auto-Pilot:** Configure the bot to wake up every $N$ hours to auto-compound rebases and claim rewards.
*   **Simulation:** Click **"Simulate Vote"** to see a dry-run of where the bot *would* vote based on current market conditions without spending gas.
*   **Odos Swap:** The interface to scan your wallet for dust tokens and execute batch swaps.

---

## 🗳️ Voting Strategies

You can choose how the bot allocates your voting power in the **Settings** tab.

### 1. Best Single Pool
*   **What it does:** The simplest strategy. It scans all active pools and identifies the single pool with the highest calculated Voter APR.
*   **How it Votes:** It allocates 100% of your configured voting power to that one winning pool.
*   **Best For:**
    *   Users with smaller veAERO positions.
    *   Scenarios where your vote size is small enough that it won't significantly dilute the APR of the top pool.

### 2. Diversify (Manual)
*   **What it does:** Allows you to manually control risk by spreading votes. It selects the top N pools by APR, where N is a number you define.
*   **How it Votes:** It splits your total voting power evenly among the selected pools.
*   **Example:** If set to 3, it votes for the top 3 pools with 33.3% power each.
*   **Example:** If set to 5, it votes for the top 5 pools with 20% power each.
*   **Best For:**
    *   Users who want to reduce smart contract risk by not going "all in" on one pool.
    *   Users who want to support specific high-yield ecosystems without concentration.

### 3. Optimized (Automatic & Dilution-Aware) 🌟
*   **What it does:** This is the "smartest" strategy. Its goal is to maximize Total Projected Dollar Rewards. It understands that casting a massive vote on a small pool crushes the APR (Dilution).
*   **How it Votes:** The bot runs an internal iterative simulation before voting:
    *   **Step 1:** Calculates projected rewards if 100% of vote goes to the #1 pool (e.g., Result: $100).
    *   **Step 2:** Calculates projected rewards if the vote is split 50/50 between #1 and #2. If your vote is large, avoiding dilution on pool #1 might result in a higher total (e.g., Result: $105).
    *   **Step 3:** It continues this logic (33/33/33, 25/25/25/25) adding pools one by one.
    *   **Decision:** It stops when adding another pool would result in diminishing returns (lower total USD). It then executes the vote using that optimal split.
*   **Best For:**
    *   Whales and Medium-Large holders.
    *   Ensures you don't "nuke" a pool's APR with your own weight, mathematically securing the highest possible income.

---

## 🔄 Rewards & Swapping (Odos)

Aerodrome rewards come in many forms (AERO, USDC, WETH, and various bribe tokens). Managing these can be tedious.

1.  **Scan Wallet:** In the Settings tab, click "Scan Wallet". The bot checks your address for whitelisted tokens.
2.  **View Value:** It lists all tokens found with a value > $0.10.
3.  **Batch Swap:** Select a target (e.g., USDC). The bot uses the **Odos Router** to swap all those disparate tokens into USDC in a single transaction sequence.

---

## 📂 File Structure

*   `server.js`: The backend brain. Handles blockchain connections, data fetching, and strategy logic.
*   `dashboard.html`: The frontend user interface.
*   `settings.json`: (Created after save) Stores your encrypted config locally.
*   `transactions.json`: (Created automatically) Stores your historical activity logs.
*   `epochs.json`: (Created automatically) Stores data for the Analysis chart.

---

## ☕ Support

This project is open-source. If it helps you increase your yields, consider supporting the developer:

*   **Donation Address (Base/EVM):** `0x22f9790175ef4f549092C91123E0f7C339CC7D3D`
*   **Community:** [Join the Discord](https://discord.gg/SGgnvyjFn5)

---

*Disclaimer: This software is provided "as is". While built with security in mind, always review the code and understand the risks of keeping private keys on a local machine.*
