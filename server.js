const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const helmet = require('helmet');
const axios = require('axios');
const ExcelJS = require('exceljs');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({
  contentSecurityPolicy: false // Allow inline scripts for development
}));
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Geolocation configurations - Only Google Shopping API supported countries
const GEOLOCATIONS = {
  // Supported European countries from your original list
  sk: { name: 'Slovakia', flag: '🇸🇰', language: 'sk' },
  cz: { name: 'Czech Republic', flag: '🇨🇿', language: 'cs' },
  hu: { name: 'Hungary', flag: '🇭🇺', language: 'hu' },
  ro: { name: 'Romania', flag: '🇷🇴', language: 'ro' },
  gr: { name: 'Greece', flag: '🇬🇷', language: 'el' },
  it: { name: 'Italy', flag: '🇮🇹', language: 'it' },
  de: { name: 'Germany', flag: '🇩🇪', language: 'de' },
  at: { name: 'Austria', flag: '🇦🇹', language: 'de' },
  pl: { name: 'Poland', flag: '🇵🇱', language: 'pl' }
};

// In-memory storage for Excel data (in production, use a database)
let excelData = [];

// DeepSeek V3 Translation Service
const translateQueryWithDeepSeek = async (query, targetLanguage, countryName) => {
  try {
    if (!process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY === 'your_deepseek_api_key_here') {
      console.log('DeepSeek API key not configured, using fallback translation');
      return fallbackTranslation(query, targetLanguage);
    }

    const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: `You are a professional translator specializing in e-commerce and product search queries. Translate the given search query to ${targetLanguage} language for ${countryName}. 
          
          Rules:
          1. Only return the translated text, no explanations
          2. Keep product names and brands in their original form if commonly used
          3. Adapt the query for local shopping context
          4. If the query is already in the target language, return it as is
          5. For technical terms, use the most commonly used local equivalent`
        },
        {
          role: 'user',
          content: `Translate this shopping search query: "${query}"`
        }
      ],
      temperature: 0.3,
      max_tokens: 100
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const translatedText = response.data.choices[0].message.content.trim();
    console.log(`DeepSeek translation: "${query}" -> "${translatedText}" (${targetLanguage})`);
    return translatedText;

  } catch (error) {
    console.error('DeepSeek translation error:', error.response?.data || error.message);
    return fallbackTranslation(query, targetLanguage);
  }
};

// Fallback translation service
const fallbackTranslation = (query, targetLanguage) => {
  const translations = {
    'fimo modellező késkészlet': {
      'sk': 'fimo modelovacie nože',
      'cs': 'fimo modelovací nože',
      'hr': 'fimo modelarski noževi',
      'hu': 'fimo modellező késkészlet',
      'de': 'fimo modelliermesser set',
      'it': 'set coltelli fimo',
      'pl': 'zestaw noży fimo'
    },
    'laptop': {
      'sk': 'notebook',
      'cs': 'notebook',
      'hr': 'laptop',
      'hu': 'laptop',
      'de': 'laptop',
      'it': 'laptop',
      'pl': 'laptop'
    }
  };

  const lowerQuery = query.toLowerCase();
  if (translations[lowerQuery] && translations[lowerQuery][targetLanguage]) {
    return translations[lowerQuery][targetLanguage];
  }
  
  return query;
};

// API Routes

// Get available geolocations
app.get('/api/geolocations', (req, res) => {
  res.json(GEOLOCATIONS);
});

// Translate query endpoint
app.post('/api/translate', async (req, res) => {
  try {
    const { query, geolocation } = req.body;
    
    if (!query || !geolocation) {
      return res.status(400).json({ error: 'Query and geolocation are required' });
    }

    if (!GEOLOCATIONS[geolocation]) {
      return res.status(400).json({ error: 'Invalid geolocation' });
    }

    const translatedQuery = await translateQueryWithDeepSeek(
      query, 
      GEOLOCATIONS[geolocation].language, 
      GEOLOCATIONS[geolocation].name
    );
    
    res.json({
      success: true,
      originalQuery: query,
      translatedQuery: translatedQuery,
      targetLanguage: GEOLOCATIONS[geolocation].language,
      geolocation: GEOLOCATIONS[geolocation]
    });

  } catch (error) {
    console.error('Translation error:', error);
    res.status(500).json({ 
      error: 'Translation failed', 
      details: error.message 
    });
  }
});

// Search Google Shopping
app.post('/api/search', async (req, res) => {
  try {
    const { query, geolocation } = req.body;
    
    if (!query || !geolocation) {
      return res.status(400).json({ error: 'Query and geolocation are required' });
    }

    if (!GEOLOCATIONS[geolocation]) {
      return res.status(400).json({ error: 'Invalid geolocation' });
    }

    // Translate query
    const translatedQuery = await translateQueryWithDeepSeek(query, GEOLOCATIONS[geolocation].language, GEOLOCATIONS[geolocation].name);
    
    // SerpAPI request
    const serpApiUrl = 'https://serpapi.com/search';
    const params = {
      engine: 'google_shopping',
      hl: 'en',
      gl: geolocation,
      q: translatedQuery,
      api_key: process.env.SERPAPI_KEY
    };

    const response = await axios.get(serpApiUrl, { params });
    
    // Filter results to only show products with multiple sources
    const filteredResults = response.data.shopping_results?.filter(
      product => product.multiple_sources === true
    ) || [];

    res.json({
      success: true,
      geolocation: geolocation,
      geoInfo: GEOLOCATIONS[geolocation],
      originalQuery: query,
      translatedQuery: translatedQuery,
      results: filteredResults,
      totalResults: filteredResults.length
    });

  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ 
      error: 'Search failed', 
      details: error.response?.data || error.message 
    });
  }
});

// Search Google Shopping for single-source products
app.post('/api/search-single-source', async (req, res) => {
  try {
    const { query, geolocation } = req.body;
    
    if (!query || !geolocation) {
      return res.status(400).json({ error: 'Query and geolocation are required' });
    }

    if (!GEOLOCATIONS[geolocation]) {
      return res.status(400).json({ error: 'Invalid geolocation' });
    }

    // Translate query
    const translatedQuery = await translateQueryWithDeepSeek(query, GEOLOCATIONS[geolocation].language, GEOLOCATIONS[geolocation].name);
    
    // SerpAPI request
    const serpApiUrl = 'https://serpapi.com/search';
    const params = {
      engine: 'google_shopping',
      hl: 'en',
      gl: geolocation,
      q: translatedQuery,
      api_key: process.env.SERPAPI_KEY
    };

    const response = await axios.get(serpApiUrl, { params });
    
    // Filter results to only show products with single sources (not multiple_sources)
    const filteredResults = response.data.shopping_results?.filter(
      product => product.multiple_sources !== true
    ) || [];

    res.json({
      success: true,
      geolocation: geolocation,
      geoInfo: GEOLOCATIONS[geolocation],
      originalQuery: query,
      translatedQuery: translatedQuery,
      results: filteredResults,
      totalResults: filteredResults.length
    });

  } catch (error) {
    console.error('Single-source search error:', error);
    res.status(500).json({ 
      error: 'Single-source search failed', 
      details: error.response?.data || error.message 
    });
  }
});

// Get product details
app.post('/api/product-details', async (req, res) => {
  try {
    const { productId, geolocation } = req.body;
    
    if (!productId || !geolocation) {
      return res.status(400).json({ error: 'Product ID and geolocation are required' });
    }

    // SerpAPI product details request
    const serpApiUrl = 'https://serpapi.com/search';
    const params = {
      engine: 'google_product',
      hl: 'en',
      gl: geolocation,
      product_id: productId,
      api_key: process.env.SERPAPI_KEY
    };

    const response = await axios.get(serpApiUrl, { params });
    
    res.json({
      success: true,
      productDetails: response.data,
      geolocation: geolocation,
      geoInfo: GEOLOCATIONS[geolocation]
    });

  } catch (error) {
    console.error('Product details error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch product details', 
      details: error.response?.data || error.message 
    });
  }
});

// Save product to Excel data
app.post('/api/save-to-excel', (req, res) => {
  try {
    const productData = req.body;
    
    // Add timestamp
    productData.savedAt = new Date().toISOString();
    
    // Add to in-memory storage
    excelData.push(productData);
    
    res.json({
      success: true,
      message: 'Product saved to Excel data',
      totalSaved: excelData.length
    });

  } catch (error) {
    console.error('Save to Excel error:', error);
    res.status(500).json({ error: 'Failed to save product data' });
  }
});

// Save multiple products to Excel data (for multiple sellers)
app.post('/api/save-multiple-to-excel', (req, res) => {
  try {
    const { products } = req.body;
    
    if (!products || !Array.isArray(products)) {
      return res.status(400).json({ error: 'Products array is required' });
    }
    
    // Add timestamp to each product
    products.forEach(productData => {
      productData.savedAt = new Date().toISOString();
      excelData.push(productData);
    });
    
    res.json({
      success: true,
      message: `${products.length} products saved to Excel data`,
      totalSaved: excelData.length
    });

  } catch (error) {
    console.error('Save multiple to Excel error:', error);
    res.status(500).json({ error: 'Failed to save product data' });
  }
});

// Export Excel file
app.get('/api/export-excel', async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Shopping Results');

    // Define columns
    worksheet.columns = [
      { header: 'Geolocation', key: 'geolocation', width: 15 },
      { header: 'Query (Translated)', key: 'translatedQuery', width: 25 },
      { header: 'Product Title', key: 'title', width: 40 },
      { header: 'Product ID', key: 'productId', width: 20 },
      { header: 'Price Range', key: 'priceRange', width: 15 },
      { header: 'Seller Count', key: 'sellerCount', width: 12 },
      { header: 'Product Link', key: 'productLink', width: 50 },
      { header: 'Seller Name', key: 'sellerName', width: 30 },
      { header: 'Seller Link', key: 'sellerLink', width: 50 },
      { header: 'Base Price', key: 'basePrice', width: 12 },
      { header: 'Shipping', key: 'shipping', width: 12 },
      { header: 'Total Price', key: 'totalPrice', width: 12 },
      { header: 'Seller Index', key: 'sellerIndex', width: 10 },
      { header: 'Saved At', key: 'savedAt', width: 20 }
    ];

    // Add data rows
    excelData.forEach(item => {
      worksheet.addRow(item);
    });

    // Style the header row
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' }
    };

    // Set response headers for file download
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=shopping-results-${Date.now()}.xlsx`);

    // Write to response
    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('Excel export error:', error);
    res.status(500).json({ error: 'Failed to export Excel file' });
  }
});

// Get current Excel data count
app.get('/api/excel-data-count', (req, res) => {
  res.json({
    count: excelData.length,
    data: excelData.map(item => ({
      title: item.title,
      geolocation: item.geolocation,
      savedAt: item.savedAt
    }))
  });
});

// Clear Excel data
app.delete('/api/excel-data', (req, res) => {
  excelData = [];
  res.json({ success: true, message: 'Excel data cleared' });
});

// Serve the main HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Multi-Geo Shopping Search Server running on http://localhost:${PORT}`);
  console.log(`📊 SerpAPI Key: ${process.env.SERPAPI_KEY ? 'Configured' : 'Missing'}`);
});
