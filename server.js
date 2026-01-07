const express = require('express');
const https = require('https');
const { Pool } = require('pg');

// PostgreSQL Database connection (Railway provides DATABASE_URL)
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
}) : null;

// Initialize database tables
async function initDatabase() {
  if (!pool) {
    console.log('⚠️ No DATABASE_URL configured - using in-memory storage only');
    return;
  }
  
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS monitored_products (
        id VARCHAR(255) PRIMARY KEY,
        url TEXT NOT NULL,
        title VARCHAR(500),
        brand VARCHAR(255),
        price VARCHAR(100),
        original_price VARCHAR(100),
        image_url TEXT,
        watched_sizes TEXT[],
        previous_stock JSONB DEFAULT '{}',
        notified_sizes TEXT[],
        created_at TIMESTAMP DEFAULT NOW(),
        last_checked TIMESTAMP DEFAULT NOW()
      )
    `);
    
    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('❌ Database initialization error:', error.message);
  }
}

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// Configuration
const CONFIG = {
  discordWebhook: process.env.DISCORD_WEBHOOK || "",
  checkIntervalMs: 60 * 1000, // Check every minute
  siteUrl: "https://www.espace-des-marques.com"
};

// Store monitored products in memory
// Structure: { "productId": { id, url, title, brand, price, imageUrl, watchedSizes: Set, previousStock: {}, notifiedSizes: Set } }
const monitoredProducts = new Map();

// Monitoring interval reference
let monitoringInterval = null;

// ============== UTILITY FUNCTIONS ==============

function getTimestamp() {
  return new Date().toLocaleString('fr-FR', { 
    timeZone: 'Europe/Paris',
    day: '2-digit',
    month: '2-digit', 
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

// Extract product ID from URL
function extractProductId(url) {
  // URL format: https://www.espace-des-marques.com/fr/116527/pantalon-de-ski-noir-femme-o-neill-gore-tex-madness
  const match = url.match(/\/fr\/(\d+)\//);
  return match ? match[1] : null;
}

// Make HTTPS request
function makeRequest(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:146.0) Gecko/20100101 Firefox/146.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr,fr-FR;q=0.8,en-US;q=0.5,en;q=0.3',
        'Accept-Encoding': 'identity', // Don't use compression for easier parsing
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

// ============== PERSISTENCE FUNCTIONS (PostgreSQL) ==============

async function saveMonitoredProducts() {
  if (!pool) return;
  
  try {
    for (const [id, product] of monitoredProducts) {
      await pool.query(`
        INSERT INTO monitored_products (id, url, title, brand, price, original_price, image_url, watched_sizes, previous_stock, notified_sizes, last_checked)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
        ON CONFLICT (id) DO UPDATE SET
          title = $3,
          brand = $4,
          price = $5,
          original_price = $6,
          image_url = $7,
          watched_sizes = $8,
          previous_stock = $9,
          notified_sizes = $10,
          last_checked = NOW()
      `, [
        id,
        product.url,
        product.title,
        product.brand,
        product.price,
        product.originalPrice,
        product.imageUrl,
        Array.from(product.watchedSizes || []),
        JSON.stringify(product.previousStock || {}),
        Array.from(product.notifiedSizes || [])
      ]);
    }
    console.log(`[${getTimestamp()}] 💾 Saved ${monitoredProducts.size} products to DB`);
  } catch (error) {
    console.error(`[${getTimestamp()}] ❌ Error saving products:`, error.message);
  }
}

async function loadMonitoredProducts() {
  if (!pool) return 0;
  
  try {
    const result = await pool.query('SELECT * FROM monitored_products');
    for (const row of result.rows) {
      monitoredProducts.set(row.id, {
        id: row.id,
        url: row.url,
        title: row.title,
        brand: row.brand,
        price: row.price,
        originalPrice: row.original_price,
        imageUrl: row.image_url,
        watchedSizes: new Set(row.watched_sizes || []),
        previousStock: row.previous_stock || {},
        notifiedSizes: new Set(row.notified_sizes || [])
      });
    }
    console.log(`[${getTimestamp()}] 📂 Loaded ${result.rows.length} products from DB`);
    return result.rows.length;
  } catch (error) {
    console.error(`[${getTimestamp()}] ❌ Error loading products:`, error.message);
  }
  return 0;
}

async function deleteProductFromDB(id) {
  if (!pool) return;
  try {
    await pool.query('DELETE FROM monitored_products WHERE id = $1', [id]);
  } catch (error) {
    console.error(`[${getTimestamp()}] ❌ Error deleting product from DB:`, error.message);
  }
}

// ============== PRODUCT FETCHING ==============

async function fetchProductInfo(url) {
  console.log(`[${getTimestamp()}] 🔍 Fetching product: ${url}`);
  
  const response = await makeRequest(url);
  
  if (response.statusCode !== 200) {
    throw new Error(`HTTP ${response.statusCode}`);
  }
  
  const html = response.body;
  
  // Extract product info from JSON-LD
  const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>\s*(\[[\s\S]*?\])\s*<\/script>/);
  let productData = {};
  
  if (jsonLdMatch) {
    try {
      const jsonLd = JSON.parse(jsonLdMatch[1]);
      const product = jsonLd.find(item => item['@type'] === 'Product') || jsonLd[0];
      if (product) {
        productData = {
          title: product.name || '',
          brand: product.brand?.name || '',
          description: product.description || '',
          sku: product.sku || '',
          image: product.image?.[0] || '',
          price: product.offers?.price || '',
          availability: product.offers?.availability || ''
        };
      }
    } catch (e) {
      console.log('Could not parse JSON-LD:', e.message);
    }
  }
  
  // Extract title from meta or HTML
  if (!productData.title) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    productData.title = titleMatch ? titleMatch[1].replace(' | Espace des marques', '').trim() : 'Unknown Product';
  }
  
  // Extract variants/sizes from data-variants attribute
  const variantsMatch = html.match(/data-variants="([^"]+)"/);
  const sizes = {};
  
  if (variantsMatch) {
    try {
      // Decode HTML entities
      const variantsJson = variantsMatch[1]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&#039;/g, "'");
      
      const variants = JSON.parse(variantsJson);
      
      for (const variant of variants) {
        const sizeName = variant.labelAddCart || 'Unknown';
        sizes[sizeName] = {
          size: sizeName,
          inStock: variant.hasStock === true,
          stockLabel: variant.labelStock || '',
          variantCode: variant.codeAlerting || variant.actionAddCart || ''
        };
      }
    } catch (e) {
      console.log('Could not parse variants:', e.message);
    }
  }
  
  // Extract image from og:image or product image
  if (!productData.image) {
    const ogImageMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/);
    productData.image = ogImageMatch ? ogImageMatch[1] : '';
  }
  
  // Extract price from page if not found in JSON-LD
  if (!productData.price) {
    const priceMatch = html.match(/class="[^"]*product-price[^"]*"[^>]*>([^<]+)</);
    productData.price = priceMatch ? priceMatch[1].trim() : '';
  }
  
  // Extract original price
  const originalPriceMatch = html.match(/class="[^"]*original-price[^"]*"[^>]*>([^<]+)</);
  productData.originalPrice = originalPriceMatch ? originalPriceMatch[1].trim() : '';
  
  return {
    title: productData.title,
    brand: productData.brand,
    price: productData.price,
    originalPrice: productData.originalPrice,
    imageUrl: productData.image,
    availability: productData.availability,
    sizes: sizes
  };
}

// ============== DISCORD NOTIFICATIONS ==============

function sendDiscordWebhook(payload) {
  if (!CONFIG.discordWebhook) {
    console.log('[Discord] No webhook configured');
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const url = new URL(CONFIG.discordWebhook);
    const postData = JSON.stringify(payload);
    
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function sendRestockNotification(product, size, stockInfo) {
  const embed = {
    title: "🚨 RESTOCK DÉTECTÉ - Espace des Marques",
    color: 0x00ff00,
    thumbnail: product.imageUrl ? { url: product.imageUrl } : undefined,
    fields: [
      { name: "📦 Produit", value: product.title || 'Unknown', inline: false },
      { name: "🏷️ Marque", value: product.brand || 'N/A', inline: true },
      { name: "📏 Taille", value: size, inline: true },
      { name: "💰 Prix", value: product.price || 'N/A', inline: true },
      { name: "📊 Stock", value: stockInfo.stockLabel || 'En stock', inline: true }
    ],
    footer: { text: "Espace des Marques Monitor" },
    timestamp: new Date().toISOString()
  };

  // Add URL button
  const components = [{
    type: 1,
    components: [{
      type: 2,
      style: 5,
      label: "🛒 Voir le produit",
      url: product.url
    }]
  }];

  return sendDiscordWebhook({ embeds: [embed], components });
}

// ============== MONITORING LOGIC ==============

async function checkProductStock(product) {
  try {
    const productInfo = await fetchProductInfo(product.url);
    const currentStock = productInfo.sizes;
    const previousStock = product.previousStock || {};
    
    // Update product info
    product.title = productInfo.title || product.title;
    product.brand = productInfo.brand || product.brand;
    product.price = productInfo.price || product.price;
    product.originalPrice = productInfo.originalPrice || product.originalPrice;
    product.imageUrl = productInfo.imageUrl || product.imageUrl;
    
    // Check for restocks
    for (const [sizeName, stockInfo] of Object.entries(currentStock)) {
      const wasInStock = previousStock[sizeName]?.inStock || false;
      const isNowInStock = stockInfo.inStock;
      
      // Check if this size is being watched (empty watchedSizes = watch all)
      const isWatched = product.watchedSizes.size === 0 || product.watchedSizes.has(sizeName);
      
      if (isWatched && !wasInStock && isNowInStock) {
        // RESTOCK DETECTED!
        console.log(`[${getTimestamp()}] 🚨 RESTOCK: ${product.title} - Taille ${sizeName}`);
        
        // Check if already notified for this size
        if (!product.notifiedSizes.has(sizeName)) {
          await sendRestockNotification(product, sizeName, stockInfo);
          product.notifiedSizes.add(sizeName);
        }
      } else if (isWatched && wasInStock && !isNowInStock) {
        // Size went out of stock - reset notification flag
        product.notifiedSizes.delete(sizeName);
      }
    }
    
    // Update previous stock
    product.previousStock = currentStock;
    
    return { success: true, sizes: currentStock };
  } catch (error) {
    console.error(`[${getTimestamp()}] ❌ Error checking ${product.url}:`, error.message);
    return { success: false, error: error.message };
  }
}

async function monitorAllProducts() {
  if (monitoredProducts.size === 0) {
    return;
  }
  
  console.log(`[${getTimestamp()}] 🔄 Checking ${monitoredProducts.size} products...`);
  
  for (const [id, product] of monitoredProducts) {
    await checkProductStock(product);
    // Small delay between products to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // Save updated data
  await saveMonitoredProducts();
  
  console.log(`[${getTimestamp()}] ✅ Check complete`);
}

function startMonitoring() {
  if (monitoringInterval) {
    console.log('Monitoring already running');
    return;
  }
  
  console.log(`⏰ Monitoring started (every ${CONFIG.checkIntervalMs / 1000}s)`);
  
  // Run immediately
  monitorAllProducts();
  
  // Then run periodically
  monitoringInterval = setInterval(monitorAllProducts, CONFIG.checkIntervalMs);
}

function stopMonitoring() {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
    console.log('⏹️ Monitoring stopped');
  }
}

// ============== API ENDPOINTS ==============

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    monitoredProducts: monitoredProducts.size,
    isMonitoring: !!monitoringInterval,
    hasDatabase: !!pool,
    hasDiscordWebhook: !!CONFIG.discordWebhook
  });
});

// Get all monitored products
app.get('/api/products', (req, res) => {
  const products = [];
  for (const [id, product] of monitoredProducts) {
    products.push({
      id,
      url: product.url,
      title: product.title,
      brand: product.brand,
      price: product.price,
      originalPrice: product.originalPrice,
      imageUrl: product.imageUrl,
      watchedSizes: Array.from(product.watchedSizes),
      previousStock: product.previousStock,
      notifiedSizes: Array.from(product.notifiedSizes)
    });
  }
  res.json({ products, isMonitoring: !!monitoringInterval });
});

// Fetch product info (preview before adding)
app.post('/api/products/fetch', async (req, res) => {
  const { url } = req.body;
  
  if (!url || !url.includes('espace-des-marques.com')) {
    return res.status(400).json({ error: 'Invalid URL - must be an Espace des Marques product URL' });
  }
  
  try {
    const productInfo = await fetchProductInfo(url);
    const productId = extractProductId(url);
    
    res.json({
      id: productId,
      url,
      ...productInfo
    });
  } catch (error) {
    console.error(`[${getTimestamp()}] Fetch error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// Add product to monitoring
app.post('/api/products', async (req, res) => {
  const { url, watchedSizes = [] } = req.body;
  
  if (!url || !url.includes('espace-des-marques.com')) {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  
  const productId = extractProductId(url);
  if (!productId) {
    return res.status(400).json({ error: 'Could not extract product ID from URL' });
  }
  
  if (monitoredProducts.has(productId)) {
    return res.status(400).json({ error: 'Product already being monitored' });
  }
  
  try {
    const productInfo = await fetchProductInfo(url);
    
    const product = {
      id: productId,
      url,
      title: productInfo.title,
      brand: productInfo.brand,
      price: productInfo.price,
      originalPrice: productInfo.originalPrice,
      imageUrl: productInfo.imageUrl,
      watchedSizes: new Set(watchedSizes),
      previousStock: productInfo.sizes,
      notifiedSizes: new Set()
    };
    
    monitoredProducts.set(productId, product);
    await saveMonitoredProducts();
    
    // Start monitoring if not already running
    startMonitoring();
    
    res.json({
      success: true,
      message: `Now monitoring: ${productInfo.title}`,
      product: {
        ...product,
        watchedSizes: Array.from(product.watchedSizes),
        notifiedSizes: Array.from(product.notifiedSizes)
      }
    });
  } catch (error) {
    console.error(`[${getTimestamp()}] Add product error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// Remove product from monitoring
app.delete('/api/products/:id', async (req, res) => {
  const { id } = req.params;
  
  if (monitoredProducts.has(id)) {
    monitoredProducts.delete(id);
    await deleteProductFromDB(id);
    
    if (monitoredProducts.size === 0) {
      stopMonitoring();
    }
    
    res.json({ success: true, message: 'Product removed' });
  } else {
    res.status(404).json({ error: 'Product not found' });
  }
});

// Update watched sizes for a product
app.put('/api/products/:id/sizes', async (req, res) => {
  const { id } = req.params;
  const { watchedSizes } = req.body;
  
  if (!monitoredProducts.has(id)) {
    return res.status(404).json({ error: 'Product not found' });
  }
  
  const product = monitoredProducts.get(id);
  product.watchedSizes = new Set(watchedSizes || []);
  await saveMonitoredProducts();
  
  res.json({ success: true, watchedSizes: Array.from(product.watchedSizes) });
});

// Reset notifications for a product
app.post('/api/products/:id/reset', async (req, res) => {
  const { id } = req.params;
  
  if (!monitoredProducts.has(id)) {
    return res.status(404).json({ error: 'Product not found' });
  }
  
  const product = monitoredProducts.get(id);
  product.notifiedSizes.clear();
  await saveMonitoredProducts();
  
  res.json({ success: true, message: 'Notifications reset' });
});

// Force check a product
app.post('/api/products/:id/check', async (req, res) => {
  const { id } = req.params;
  
  if (!monitoredProducts.has(id)) {
    return res.status(404).json({ error: 'Product not found' });
  }
  
  const product = monitoredProducts.get(id);
  const result = await checkProductStock(product);
  await saveMonitoredProducts();
  
  res.json({ success: true, ...result });
});

// Start/Stop monitoring
app.post('/api/monitoring/start', (req, res) => {
  startMonitoring();
  res.json({ success: true, message: 'Monitoring started' });
});

app.post('/api/monitoring/stop', (req, res) => {
  stopMonitoring();
  res.json({ success: true, message: 'Monitoring stopped' });
});

// Keep-alive ping
app.get('/ping', (req, res) => {
  res.send('pong');
});

// Store server start time
const serverStartTime = new Date();

// Start server with async initialization
async function startServer() {
  // Initialize database first
  await initDatabase();
  
  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║  🛍️  Espace des Marques - Stock Monitor                      ║
║  Server running on port ${String(PORT).padEnd(37)} ║
║  Started at: ${serverStartTime.toISOString().padEnd(48)} ║
║  Health check: /health or /ping                              ║
║  Database: ${pool ? 'PostgreSQL ✅' : 'In-memory only ⚠️'}${pool ? '' : '                          '}             ║
╚══════════════════════════════════════════════════════════════╝
    `);
    
    // Load persisted data from database
    const loadedProducts = await loadMonitoredProducts();
    
    // Start monitoring if products were loaded
    if (loadedProducts > 0) {
      console.log(`🚀 Starting monitoring for ${loadedProducts} restored products`);
      startMonitoring();
    }
    
    // Log config status
    console.log(`🔔 Discord webhook: ${CONFIG.discordWebhook ? 'Configured ✅' : 'Not configured'}`);
    console.log(`🗄️ Database: ${pool ? 'PostgreSQL connected' : 'No database (data will not persist)'}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
