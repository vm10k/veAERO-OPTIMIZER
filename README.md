# veAERO Yield Optimizer (Self-Hosted Dashboard)

<img width="1036" height="256" alt="veAERO Dashboard Interface" src="https://github.com/user-attachments/assets/48ba8a69-d58e-404c-ae7f-66e425e95d81" />

**veAERO Optimizer** is a local, open-source automation tool designed for **Aerodrome Finance** on the Base network. It manages your `veAERO` NFTs to maximize weekly voting yield through intelligent APR analysis, auto-voting strategies, and rewards compounding.

Unlike web-hosted dApps, this tool runs entirely on your local machine (`localhost`), ensuring complete control over your private keys and data.

## 🛡️ Security & Architecture (Why Local?)

In an era of frequent **DNS hijacks**, **frontend exploits**, and **phishing domains**, trusting a website with your wallet interaction is risky.

**veAERO Optimizer mitigates these risks by removing the "Web" from the equation:**

1.  **Local Execution:** The dashboard (`dashboard.html`) opens directly from your hard drive. The backend (`server.js`) runs on your machine.
2.  **Keys Stay Local:** Your private key is stored in a local file (`settings.json`) generated on your computer. It is **never** transmitted to any cloud server or API.
3.  **Direct RPC Connection:** The bot communicates directly with the Base blockchain nodes (RPC). There is no middleman API that can be compromised to feed you false data.
4.  **Open Source:** The code is transparent. You can read exactly how the bot constructs transactions before you run it.

---

## 🚀 Key Features

*   **Real-Time APR Scanning:** Fetches live Bribe and Fee data from the blockchain to calculate the *actual* Voter APR (vAPR), not just estimated averages.
*   **Smart Auto-Voting:** Automatically casts votes for the highest yielding pools based on your chosen strategy.
*   **Inflation Protection (Rebase):** One-click or automated claiming of weekly rebases to grow your voting power and prevent dilution.
*   **Reward Aggregation:** Scans all pools for hidden Bribes and Trading Fees earned by your NFT.
*   **Integrated Odos Swap:** A built-in aggregator that scans your wallet for scattered reward tokens (USDC, WETH, DEGEN, etc.) and performs a batch swap to a single asset (like USDC) in one transaction.
*   **Performance Tracking:** A visual chart comparing your specific NFT's performance against the "Market Index" (Average of the Top 3 pools not the best analysis but ok).

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

### 1. Manual Voting
Total control for the user.
1.  Go to the **Pools** tab.
2.  Select specific pools via "Pick Pool".
3.  Open the Sidebar.
4.  Use sliders to adjust the weight (e.g., 40% Pool A, 60% Pool B).
5.  Click **"Cast Vote"**.

### 2. Auto-Strategy: Best Single Pool
*   **Logic:** Scans all pools, finds the one with the highest vAPR.
*   **Allocation:** 100% of votes go to that single pool.
*   **Use Case:** Small voting power where your vote won't dilute the pool's APR.

### 3. Auto-Strategy: Diversified (Manual Split)
*   **Logic:** You define a number (e.g., Top 5). The bot finds the top 5 highest yielding pools.
*   **Allocation:** Splits power evenly (e.g., 20% each).
*   **Use Case:** Risk management; avoiding "all eggs in one basket."

### 4. Auto-Strategy: Optimized (Dilution Aware) 🌟
*   **Logic:** The bot runs a complex simulation. It calculates: "If I vote 100% on Pool A, does the APR drop so much that Pool B becomes better?"
*   **Allocation:** It dynamically calculates the perfect split (e.g., 63% Pool A, 27% Pool B, 10% Pool C) to maximize **Total USD Rewards**.
*   **Use Case:** Whales and Large holders. This prevents you from "nuking" your own yield.

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
