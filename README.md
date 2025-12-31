<img width="1036" height="256" alt="image" src="https://github.com/user-attachments/assets/48ba8a69-d58e-404c-ae7f-66e425e95d81" />

# veAERO Yield Optimizer

**veAERO Optimizer** is a local, self-hosted automation tool designed for **Aerodrome Finance** on the Base network. It manages your `veAERO` NFTs to maximize weekly voting yield through intelligent APR analysis, auto-voting, and rewards compounding.

It features a **Retro-themed Dashboard** that runs locally on your machine, ensuring your keys and data remain under your control.

## 🚀 Key Features

*   **Auto-Voting:** Automatically scans the blockchain for the highest bribed pools and casts votes before the epoch ends.
*   **Inflation Protection (Rebase):** One-click or automated claiming of weekly rebases to grow your voting power.
*   **Reward Aggregation:** Scans all pools for Bribes and Trading Fees earned by your NFT.
*   **Integrated Swap (Odos):** Aggregates scattered reward tokens (USDC, AERO, WETH, etc.) and swaps them into a single target asset using the Odos router.
*   **Performance Tracking:** Tracks your specific APR vs. the Market Index (Top 3 pools) over time.

---

## 🧠 Voting Strategies

The core of the optimizer is its ability to choose *how* to vote. You can select one of three strategies in the Settings tab.

### 1. Best Single Pool
*   **What it does:** The simplest strategy. It scans all active pools and identifies the single pool with the highest calculated Voter APR.
*   **How it Votes:** It allocates **100%** of your configured voting power to that one winning pool.
*   **Best For:**
    *   Users with smaller `veAERO` positions.
    *   Scenarios where your vote size is small enough that it won't significantly dilute the APR of the top pool.

### 2. Diversify (Manual)
*   **What it does:** Allows you to manually control risk by spreading votes. It selects the top *N* pools by APR, where *N* is a number you define.
*   **How it Votes:** It splits your total voting power evenly among the selected pools.
    *   *Example:* If set to **3**, it votes for the top 3 pools with **33.3%** power each.
    *   *Example:* If set to **5**, it votes for the top 5 pools with **20%** power each.
*   **Best For:**
    *   Users who want to reduce smart contract risk by not going "all in" on one pool.
    *   Users who want to support specific high-yield ecosystems without concentration.

### 3. Optimized (Automatic & Dilution-Aware) 🌟
*   **What it does:** This is the "smartest" strategy. Its goal is to maximize **Total Projected Dollar Rewards**. It understands that casting a massive vote on a small pool crushes the APR (Dilution).
*   **How it Votes:** The bot runs an internal iterative simulation before voting:
    1.  **Step 1:** Calculates projected rewards if 100% of vote goes to the #1 pool (e.g., Result: $100).
    2.  **Step 2:** Calculates projected rewards if the vote is split 50/50 between #1 and #2. If your vote is large, avoiding dilution on pool #1 might result in a higher total (e.g., Result: $105).
    3.  **Step 3:** It continues this logic (33/33/33, 25/25/25/25) adding pools one by one.
    4.  **Decision:** It stops when adding another pool would result in *diminishing returns* (lower total USD). It then executes the vote using that optimal split.
*   **Best For:**
    *   **Whales and Medium-Large holders.**
    *   Ensures you don't "nuke" a pool's APR with your own weight, mathematically securing the highest possible income.

---

## 🛠️ Installation

### Prerequisites
*   [Node.js](https://nodejs.org/) (v16 or higher) installed.
*   A wallet with `veAERO` on the Base Network.

### Setup
1.  **Clone or Download** this repository.
2.  Open a terminal in the project folder.
3.  **Install Dependencies**:
    ```bash
    npm install
    ```
    *This installs necessary libraries defined in `package.json` including `ethers`, `ws`, and others.*

4.  **Start the Server**:
    ```bash
    npm start
    ```
5.  **Open the Dashboard**:
    Double-click `dashboard.html` in your file explorer, or drag it into your browser.

---

## ⚙️ Configuration

1.  **Connect:** Open `dashboard.html`. The status light in the top right should turn **Green** (Connected).
2.  **Settings:**
    *   Navigate to the **Settings** tab.
    *   **Token ID:** Enter your veNFT ID (e.g., `12345`). You can find this on the Aerodrome website or block explorer.
    *   **Private Key:** (Optional, for Auto-Voting only). Enter your wallet private key.
        *   *Note: This key is stored locally in `settings.json` and is never transmitted to any external server.*
    *   **Strategy:** Select your desired voting strategy (Optimized is recommended).
3.  **Save:** Click "Confirm & Save Settings".

---

## 📦 Dependencies

This project relies on the following standard Node.js libraries:

*   **ethers**: For interacting with the Base blockchain and Aerodrome contracts.
*   **ws**: To host the local WebSocket server communicating between the backend and the dashboard.
*   **puppeteer / express**: Included for potential future web-scraping or API expansions.

---

## ☕ Support & Community

This tool is open-source and free to use. If it helps you maximize your yields, consider supporting development!

*   **Donation Address (EVM/Base):**
    `0x22f9790175ef4f549092C91123E0f7C339CC7D3D`

*   **Join the Community:**
    [Join the Discord Channel](https://discord.gg/SGgnvyjFn5)

---

*Disclaimer: This software is provided "as is", without warranty of any kind. Use at your own risk. Always verify transactions before signing.*
