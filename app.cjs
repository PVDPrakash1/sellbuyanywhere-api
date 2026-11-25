// Startup file for cPanel / Phusion Passenger "Setup Node.js App" (set "Application startup file" to app.cjs).
// Passenger loads this file with require(); the real app is an ES module, so it is loaded with import().
import('./index.js').catch((e) => { console.error('Failed to start:', e); process.exit(1); });
