# AdHash Dashboard - Setup Instructions

## 🎯 What You Have

A **unified web dashboard** that runs all your AdHash project test suites with a single button click and displays results in real-time.

## 📋 Quick Start (Easiest Way)

### Option 1: Double-click the batch file
Simply double-click `start-dashboard.bat` and the dashboard will:
- Install dependencies (if needed)
- Install Playwright browsers (if needed)
- Start the server
- Open your browser automatically

### Option 2: Manual start
1. Open terminal/command prompt
2. Navigate to the project folder
3. Run: `npm start`
4. Open browser to: `http://localhost:5001`

## 🚀 How to Use the Dashboard

1. **Start the Server**
   - Run `start-dashboard.bat` OR
   - Run `npm start` in terminal

2. **Open the Dashboard**
   - Browser should open automatically
   - If not, go to: `http://localhost:5001`

3. **Run Tests**
   - Click the big **"▶️ Run All Tests"** button
   - Watch the tests execute in real-time
   - View results directly in the dashboard

4. **View Results**
   - Each test suite shows:
     - ✅ Status (Passed/Failed)
     - 📊 Statistics (Total, Passed, Failed, Warnings)
     - ⏱️ Duration
     - 📝 Detailed results
   - Logs appear at the bottom in real-time

## 📦 What's Included

### Test Suites (4 Total)
1. **📱 App Status Verification**
   - Verifies Play Store & App Store apps
   - Checks 9 apps across 2 platforms

2. **🖥️ Server Health Monitoring**
   - Monitors 22 production servers
   - Checks server availability and response

3. **🔒 SSL Certificate Monitoring**
   - Checks 25 SSL certificates
   - Warns about expiring certificates

4. **🌐 API Endpoint Testing**
   - Tests 41 API endpoints
   - Validates API responses

## 📁 Project Structure

```
AdHash_Dashboard/
├── start-dashboard.bat     ← Double-click to start!
├── server.js              ← Backend server
├── package.json           ← Dependencies
├── public/
│   └── index.html         ← Dashboard UI
├── tests/                 ← All test suites
│   ├── app-status/
│   ├── server-health/
│   ├── certificate/
│   └── api/
└── README.md              ← Full documentation
```

## ⚙️ Technical Details

- **Server**: Node.js + Express
- **Port**: 5001 (http://localhost:5001)
- **Testing**: Playwright
- **Real-time Updates**: Server-Sent Events (SSE)
- **No Database**: Everything runs in memory
- **No Commits**: Nothing is saved to git

## 🔧 Troubleshooting

### Server won't start
- **Error: Port already in use**
  - Close other applications using port 5001
  - Or change PORT in `server.js` line 7

### Tests fail to run
- Make sure dependencies are installed: `npm install`
- Install Playwright browsers: `npx playwright install chromium`

### Browser doesn't open
- Manually navigate to: `http://localhost:5001`
- Check if server is running (look for success message in terminal)

### Dashboard shows errors
- Refresh the browser page
- Restart the server (Ctrl+C, then run again)

## 🎨 Dashboard Features

### Summary Cards
- Total test suites
- Successful tests
- Failed tests
- Total duration

### Test Suite Cards
Each card shows:
- Suite name and icon
- Description
- Status badge (Running/Passed/Failed)
- Statistics (Total, Passed, Failed, Warnings)
- Duration
- Detailed test results

### Live Logs
- Real-time execution logs
- Color-coded messages (Info/Warning/Error)
- Auto-scrolling

## 📝 Important Notes

1. **Local Only**: Everything runs on your local machine
2. **No Commits**: Nothing is saved to the repository
3. **Fresh Results**: Each run shows new results
4. **Sequential Execution**: Tests run one suite at a time
5. **Browser Required**: You need a web browser to view the dashboard

## 🆘 Need Help?

1. Check the terminal for error messages
2. Read the full README.md for detailed documentation
3. Make sure Node.js is installed (v18 or higher)
4. Ensure you have internet connection (for downloading dependencies)

## 🎉 That's It!

You're all set! Just run `start-dashboard.bat` and start testing!

