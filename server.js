const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const OpenAI = require('openai');
require('dotenv').config();

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase client with anon key (for general queries)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Supabase client with service role key (bypasses RLS - for user management)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API endpoint to get config
app.get('/api/config', (req, res) => {
  res.json({
    mapsApiKey: process.env.GOOGLE_MAPS_API_KEY,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY
  });
});

// Signup endpoint - creates user record using service role (bypasses RLS)
app.post('/api/signup', async (req, res) => {
  try {
    const { userId, email, name } = req.body;

    if (!userId || !email || !name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Insert user record using admin client (bypasses RLS)
    const { error } = await supabaseAdmin
      .from('users')
      .insert({
        id: userId,
        email: email,
        name: name,
        approved: false,
        is_admin: false
      });

    if (error) {
      console.error('Error creating user record:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Failed to create user record' });
  }
});

// Geocoding proxy endpoint
app.get('/api/geocode', async (req, res) => {
  const { address } = req.query;

  if (!address) {
    return res.status(400).json({ error: 'Address is required' });
  }

  try {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;

    const response = await fetch(url);
    const data = await response.json();

    res.json(data);
  } catch (error) {
    console.error('Geocoding error:', error);
    res.status(500).json({ error: 'Failed to geocode address' });
  }
});

// Get all users (admin only)
app.get('/api/admin/users', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Approve user (admin only)
app.post('/api/admin/approve/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    // Confirm user's email in Supabase Auth
    const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      email_confirm: true
    });

    if (authError) {
      console.error('Error confirming user email:', authError);
      throw authError;
    }

    // Update approved status in users table
    const { data, error } = await supabaseAdmin
      .from('users')
      .update({ approved: true })
      .eq('id', userId)
      .select();

    if (error) throw error;
    res.json({ success: true, user: data[0] });
  } catch (error) {
    console.error('Error approving user:', error);
    res.status(500).json({ error: 'Failed to approve user' });
  }
});

// Delete user (admin only)
app.delete('/api/admin/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { error } = await supabaseAdmin
      .from('users')
      .delete()
      .eq('id', userId);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// ============================================
// VISUALIZER ENDPOINTS
// ============================================

// Upload image to Supabase Storage
app.post('/api/upload-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    const file = req.file;
    const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${file.mimetype.split('/')[1]}`;
    const filePath = `uploads/${fileName}`;

    // Upload to Supabase Storage
    const { data, error } = await supabaseAdmin.storage
      .from('visualizer-images')
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false
      });

    if (error) {
      console.error('Supabase storage error:', error);
      throw error;
    }

    // Get public URL
    const { data: urlData } = supabaseAdmin.storage
      .from('visualizer-images')
      .getPublicUrl(filePath);

    res.json({
      success: true,
      url: urlData.publicUrl,
      path: filePath
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// Generate AI visualization
app.post('/api/visualize', async (req, res) => {
  try {
    const { imageUrl, type, options } = req.body;

    if (!imageUrl || !type || !options) {
      return res.status(400).json({ error: 'Missing required fields: imageUrl, type, options' });
    }

    // Build the prompt based on visualization type
    let prompt = '';

    if (type === 'paint') {
      prompt = `Transform this house/building image by changing the exterior paint color to ${options.color}.
        Keep all other elements exactly the same (windows, doors, roof, landscaping, etc.).
        The new paint color should look realistic and professionally applied.
        Maintain the same lighting, shadows, and perspective.`;
    } else if (type === 'fence') {
      prompt = `Add or replace the fence in this property image with a ${options.material} ${options.style} fence.
        The fence should look realistic and professionally installed.
        Keep all other elements of the image exactly the same.
        Maintain the same lighting, shadows, and perspective.`;
    } else if (type === 'roof') {
      prompt = `Transform this house image by changing the roof shingles to ${options.color} colored shingles.
        Keep all other elements exactly the same (walls, windows, doors, landscaping, etc.).
        The new roof should look realistic with proper texture and shadows.
        Maintain the same lighting and perspective.`;
    } else {
      return res.status(400).json({ error: 'Invalid visualization type. Use: paint, fence, or roof' });
    }

    // First, analyze the image with GPT-4 Vision to understand it better
    const analysisResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Analyze this house/property image and describe it in detail for image generation purposes.
                     Focus on: architectural style, current colors, materials, landscaping, lighting conditions, and camera angle.
                     Keep the description concise but detailed enough to recreate the image with modifications.`
            },
            {
              type: 'image_url',
              image_url: { url: imageUrl }
            }
          ]
        }
      ],
      max_tokens: 500
    });

    const imageDescription = analysisResponse.choices[0].message.content;

    // Generate the new image with DALL-E 3
    const generationPrompt = `${imageDescription}\n\nNow, ${prompt}\n\nCreate a photorealistic image that looks like a real photograph.`;

    const imageResponse = await openai.images.generate({
      model: 'dall-e-3',
      prompt: generationPrompt,
      n: 1,
      size: '1024x1024',
      quality: 'standard',
      style: 'natural'
    });

    const generatedImageUrl = imageResponse.data[0].url;

    // Download and store the generated image in Supabase
    const imageData = await fetch(generatedImageUrl);
    const imageBuffer = Buffer.from(await imageData.arrayBuffer());

    const fileName = `generated/${Date.now()}-${Math.random().toString(36).substring(7)}.png`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from('visualizer-images')
      .upload(fileName, imageBuffer, {
        contentType: 'image/png',
        upsert: false
      });

    if (uploadError) {
      console.error('Error storing generated image:', uploadError);
      // Return the temporary URL if storage fails
      return res.json({
        success: true,
        originalUrl: imageUrl,
        generatedUrl: generatedImageUrl,
        description: imageDescription,
        temporary: true
      });
    }

    // Get permanent public URL
    const { data: urlData } = supabaseAdmin.storage
      .from('visualizer-images')
      .getPublicUrl(fileName);

    res.json({
      success: true,
      originalUrl: imageUrl,
      generatedUrl: urlData.publicUrl,
      description: imageDescription,
      temporary: false
    });

  } catch (error) {
    console.error('Visualization error:', error);
    res.status(500).json({
      error: 'Failed to generate visualization',
      details: error.message
    });
  }
});

// Serve login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Serve admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Serve main app
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// Redirect root to login
app.get('/', (req, res) => {
  res.redirect('/login');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
