const { spawn } = require('child_process');
const path = require('path');

console.log('🚀 Starting 4Digits Chat Server with Graceful Shutdown...');
console.log('');

// Start the actual server
const serverProcess = spawn('node', ['server.js'], {
  stdio: 'inherit',
  cwd: __dirname
});

// Handle process termination
function gracefulShutdown(signal) {
  console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
  
  if (serverProcess && !serverProcess.killed) {
    // Send SIGINT to the server process
    serverProcess.kill('SIGINT');
    
    // Wait for the process to exit
    serverProcess.on('exit', (code) => {
      console.log(`✅ Server process exited with code ${code}`);
      process.exit(0);
    });
    
    // Force exit after 10 seconds if server doesn't respond
    setTimeout(() => {
      console.log('⚠️ Force killing server process...');
      serverProcess.kill('SIGKILL');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
}

// Handle various termination signals
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle Windows-specific signals
if (process.platform === 'win32') {
  // Handle Ctrl+C
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  
  // Handle window close (Windows specific)
  process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));
  
  // Handle process termination
  process.on('exit', () => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM');
    }
  });
}

// Handle server process errors
serverProcess.on('error', (err) => {
  console.error('❌ Server process error:', err);
  process.exit(1);
});

serverProcess.on('exit', (code, signal) => {
  if (code !== 0 && code !== null) {
    console.error(`❌ Server process exited with code ${code} and signal ${signal}`);
    process.exit(code);
  }
});

// Keep the wrapper process alive
process.stdin.resume();
