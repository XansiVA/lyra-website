const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 8000;
const PACKAGES_DIR = path.join(__dirname, 'packages');
const STATS_FILE = path.join(__dirname, 'stats.json');

// Server statistics
let stats = {
    totalDownloads: 0,
    packageDownloads: {},
    startTime: Date.now(),
    lastDownload: null
};

// Load stats from file if exists
function loadStats() {
    try {
        if (fs.existsSync(STATS_FILE)) {
            const data = fs.readFileSync(STATS_FILE, 'utf8');
            stats = JSON.parse(data);
            console.log('Loaded statistics from disk');
        }
    } catch (err) {
        console.error('Error loading stats:', err.message);
    }
}

// Save stats to file
function saveStats() {
    try {
        fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
    } catch (err) {
        console.error('Error saving stats:', err.message);
    }
}

// Track download
function trackDownload(packageName, version) {
    stats.totalDownloads++;
    stats.lastDownload = {
        package: packageName,
        version: version,
        timestamp: Date.now()
    };
    
    const key = `${packageName}@${version}`;
    if (!stats.packageDownloads[key]) {
        stats.packageDownloads[key] = 0;
    }
    stats.packageDownloads[key]++;
    
    saveStats();
}

// Get system usage
function getSystemUsage() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    
    cpus.forEach(cpu => {
        for (const type in cpu.times) {
            totalTick += cpu.times[type];
        }
        totalIdle += cpu.times.idle;
    });
    
    const cpuUsage = 100 - ~~(100 * totalIdle / totalTick);
    
    return {
        memory: {
            total: totalMem,
            used: usedMem,
            free: freeMem,
            percentUsed: ((usedMem / totalMem) * 100).toFixed(2)
        },
        cpu: {
            cores: cpus.length,
            usage: cpuUsage,
            model: cpus[0].model
        },
        platform: os.platform(),
        hostname: os.hostname()
    };
}

// Format uptime
function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${secs}s`);
    
    return parts.join(' ');
}

// Middleware
app.use(express.json());

loadStats();

// Ensure packages directory exists
if (!fs.existsSync(PACKAGES_DIR)) {
    fs.mkdirSync(PACKAGES_DIR, { recursive: true });
    console.log('Created packages directory:', PACKAGES_DIR);
}

// Generate package index on startup
function generatePackageIndex() {
    const index = {};
    
    try {
        const files = fs.readdirSync(PACKAGES_DIR);
        
        for (const file of files) {
            if (file.endsWith('.tar.gz')) {
                const filePath = path.join(PACKAGES_DIR, file);
                const stats = fs.statSync(filePath);
                
                // Extract package name and version from filename
                // Expected format: packagename-version-arch.tar.gz
                const match = file.match(/^(.+?)-(.+?)(?:-.*)?\.tar\.gz$/);
                
                if (match) {
                    const [, name, version] = match;
                    
                    // Calculate SHA256 hash
                    const fileBuffer = fs.readFileSync(filePath);
                    const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
                    
                    if (!index[name]) {
                        index[name] = [];
                    }
                    
                    index[name].push({
                        version,
                        filename: file,
                        size: stats.size,
                        hash,
                        uploaded: stats.mtime
                    });
                }
            }
        }
        
        // Sort versions for each package (newest first)
        for (const pkg in index) {
            index[pkg].sort((a, b) => {
                // Simple version comparison (works for semver-like versions)
                const versionA = a.version.split('.').map(Number);
                const versionB = b.version.split('.').map(Number);
                
                for (let i = 0; i < Math.max(versionA.length, versionB.length); i++) {
                    const numA = versionA[i] || 0;
                    const numB = versionB[i] || 0;
                    if (numA !== numB) return numB - numA;
                }
                return 0;
            });
        }
        
    } catch (err) {
        console.error('Error generating package index:', err.message);
    }
    
    return index;
}

let packageIndex = generatePackageIndex();

// API Routes

// List all available packages
app.get('/api/packages', (req, res) => {
    res.json({
        count: Object.keys(packageIndex).length,
        packages: packageIndex
    });
});

// Search for a package
app.get('/api/search/:query', (req, res) => {
    const query = req.params.query.toLowerCase();
    const results = {};
    
    for (const [name, versions] of Object.entries(packageIndex)) {
        if (name.toLowerCase().includes(query)) {
            results[name] = versions;
        }
    }
    
    res.json({
        query,
        count: Object.keys(results).length,
        results
    });
});

// Get specific package info
app.get('/api/package/:name', (req, res) => {
    const name = req.params.name;
    
    if (packageIndex[name]) {
        res.json({
            name,
            versions: packageIndex[name]
        });
    } else {
        res.status(404).json({
            error: 'Package not found',
            name
        });
    }
});

// Download package (latest version)
app.get('/packages/:name', (req, res) => {
    const name = req.params.name;
    
    if (!packageIndex[name] || packageIndex[name].length === 0) {
        return res.status(404).json({
            error: 'Package not found',
            name
        });
    }
    
    const latest = packageIndex[name][0];
    const filePath = path.join(PACKAGES_DIR, latest.filename);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({
            error: 'Package file not found on server',
            filename: latest.filename
        });
    }
    
    console.log(`Serving ${name} v${latest.version} (${latest.filename})`);
    trackDownload(name, latest.version);
    res.download(filePath, latest.filename);
});

// Download specific version
app.get('/packages/:name/:version', (req, res) => {
    const { name, version } = req.params;
    
    if (!packageIndex[name]) {
        return res.status(404).json({
            error: 'Package not found',
            name
        });
    }
    
    const packageVersion = packageIndex[name].find(v => v.version === version);
    
    if (!packageVersion) {
        return res.status(404).json({
            error: 'Version not found',
            name,
            version,
            available: packageIndex[name].map(v => v.version)
        });
    }
    
    const filePath = path.join(PACKAGES_DIR, packageVersion.filename);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({
            error: 'Package file not found on server',
            filename: packageVersion.filename
        });
    }
    
    console.log(`Serving ${name} v${version} (${packageVersion.filename})`);
    trackDownload(name, version);
    res.download(filePath, packageVersion.filename);
});

// Refresh package index (useful after adding new packages)
app.post('/api/refresh', (req, res) => {
    console.log('Refreshing package index...');
    packageIndex = generatePackageIndex();
    res.json({
        message: 'Package index refreshed',
        count: Object.keys(packageIndex).length
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        packages: Object.keys(packageIndex).length,
        uptime: process.uptime()
    });
});

// Server statistics endpoint
app.get('/api/stats', (req, res) => {
    const uptime = (Date.now() - stats.startTime) / 1000;
    const usage = getSystemUsage();
    
    // Get top 10 most downloaded packages
    const topPackages = Object.entries(stats.packageDownloads)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([pkg, count]) => ({ package: pkg, downloads: count }));
    
    res.json({
        server: {
            uptime: formatUptime(uptime),
            uptimeSeconds: uptime,
            packagesAvailable: Object.keys(packageIndex).length
        },
        downloads: {
            total: stats.totalDownloads,
            lastDownload: stats.lastDownload,
            topPackages
        },
        system: usage
    });
});

// Root endpoint with info
app.get('/', (req, res) => {
    res.json({
        name: 'Lyra Package Server',
        version: '1.0.0',
        endpoints: {
            'GET /api/packages': 'List all packages',
            'GET /api/search/:query': 'Search packages',
            'GET /api/package/:name': 'Get package info',
            'GET /packages/:name': 'Download latest version',
            'GET /packages/:name/:version': 'Download specific version',
            'POST /api/refresh': 'Refresh package index',
            'GET /health': 'Health check'
        },
        packagesAvailable: Object.keys(packageIndex).length
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        path: req.path
    });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log('Lyra Package Server started');
    console.log(`→ Listening on port ${PORT}`);
    console.log(`→ Package directory: ${PACKAGES_DIR}`);
    console.log(`→ Packages available: ${Object.keys(packageIndex).length}`);
    console.log(`→ Total downloads: ${stats.totalDownloads}`);
    console.log('');
    console.log('Available at:');
    console.log(`  http://localhost:${PORT}`);
    console.log(`  http://0.0.0.0:${PORT}`);
    console.log('');
    console.log('Ready to serve packages');
    
    // Display stats every 30 seconds
    setInterval(() => {
        const uptime = (Date.now() - stats.startTime) / 1000;
        const usage = getSystemUsage();
        
        console.log('');
        console.log('=== Server Status ===');
        console.log(`Uptime: ${formatUptime(uptime)}`);
        console.log(`Packages: ${Object.keys(packageIndex).length}`);
        console.log(`Total downloads: ${stats.totalDownloads}`);
        console.log(`CPU: ${usage.cpu.usage}% (${usage.cpu.cores} cores)`);
        console.log(`Memory: ${usage.memory.percentUsed}% used (${(usage.memory.used / 1024 / 1024 / 1024).toFixed(2)} GB / ${(usage.memory.total / 1024 / 1024 / 1024).toFixed(2)} GB)`);
        
        if (stats.lastDownload) {
            const timeSince = (Date.now() - stats.lastDownload.timestamp) / 1000;
            console.log(`Last download: ${stats.lastDownload.package}@${stats.lastDownload.version} (${Math.floor(timeSince)}s ago)`);
        }
    }, 30000);
});