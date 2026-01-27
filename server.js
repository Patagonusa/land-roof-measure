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

// Generate AI visualization using img2img (preserves original image structure)
app.post('/api/visualize', async (req, res) => {
  try {
    const { imageUrl, type, options } = req.body;

    if (!imageUrl || !type || !options) {
      return res.status(400).json({ error: 'Missing required fields: imageUrl, type, options' });
    }

    // Build the instruction prompt based on visualization type
    let prompt = '';

    if (type === 'paint') {
      prompt = `Change ONLY the house exterior wall siding paint color to ${options.color}. Keep the roof, gutters, trim, windows, doors, and all other elements exactly the same color as original. Only change the main wall surfaces.`;
    } else if (type === 'fence') {
      // Detailed descriptions per fence type for better AI results
      const fenceDescriptions = {
        'vinyl white': 'a white vinyl privacy fence with smooth solid panels, clean post caps, and no gaps between sections',
        'vinyl tan': 'a tan beige vinyl privacy fence with smooth solid panels, post caps, and uniform color throughout',
        'vinyl brown': 'a dark brown vinyl privacy fence with smooth solid panels, matching brown post caps, and rich chocolate brown color',
        'wood natural cedar': 'a natural cedar wood privacy fence with tight vertical boards showing visible wood grain and natural warm cedar tone',
        'wood dark stained': 'a dark stained wood privacy fence with vertical boards and deep brown wood stain finish',
        'wood white painted': 'a white painted wood fence with evenly spaced pickets and clean white paint finish',
        'metal black wrought iron': 'a black wrought iron ornamental fence with evenly spaced vertical bars and decorative pointed finials on top',
        'metal bronze': 'a bronze colored metal ornamental fence with evenly spaced vertical bars and a warm bronze metallic finish',
        'chain link silver galvanized': 'a silver galvanized chain link fence with metal posts and diamond-pattern wire mesh'
      };

      const fenceKey = `${options.material} ${options.style}`;
      const fenceDesc = fenceDescriptions[fenceKey] || `a ${options.material} ${options.style} fence`;

      prompt = `Change ONLY the fence in this property photo to ${fenceDesc}. The new fence must completely replace the existing fence so the old fence is no longer visible. Keep the house, roof, walls, windows, doors, driveway, yard, landscaping, trees, sky, and all other elements exactly the same.`;
    } else if (type === 'roof') {
      prompt = `Change ONLY the roof shingles to ${options.color} color. Keep the walls, siding, gutters, trim, and all other elements exactly the same color as original.`;
    } else if (type === 'flooring') {
      let flooringDesc = options.style || 'hardwood';
      if (options.category === 'carpet' && options.carpetType) {
        flooringDesc = `${options.carpetType} ${flooringDesc}`;
      }

      const preserveClause = 'DO NOT change the walls, windows, doors, ceiling, furniture, fixtures, baseboards, trim, lighting, or any other element. Every single detail of the room must remain identical except the floor. The windows must stay exactly as they are.';

      if (options.category === 'carpet') {
        prompt = `Edit this interior room photo: replace ONLY the floor with ${flooringDesc} wall-to-wall. The carpet must cover the entire floor area. ${preserveClause}`;
      } else if (options.category === 'tile') {
        prompt = `Edit this interior room photo: replace ONLY the floor with ${flooringDesc} with visible grout lines, professionally installed. ${preserveClause}`;
      } else if (options.category === 'hardwood') {
        prompt = `Edit this interior room photo: replace ONLY the floor with ${flooringDesc} planks with visible wood grain running lengthwise. ${preserveClause}`;
      } else if (options.category === 'lvp') {
        prompt = `Edit this interior room photo: replace ONLY the floor with ${flooringDesc} with realistic plank pattern. ${preserveClause}`;
      } else {
        prompt = `Edit this interior room photo: replace ONLY the floor with ${flooringDesc}, professionally installed. ${preserveClause}`;
      }
    } else {
      return res.status(400).json({ error: 'Invalid visualization type. Use: paint, fence, roof, or flooring' });
    }

    console.log('Starting visualization with prompt:', prompt);
    console.log('Image URL:', imageUrl);

    // Download the original image and convert to base64
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch image: ${imageResponse.status}`);
    }
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    const base64Image = imageBuffer.toString('base64');

    console.log('Image downloaded, size:', imageBuffer.length);
    console.log('Sending to Google Vertex AI Imagen...');

    // Use Google Vertex AI Imagen API for image editing
    const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID || 'neat-encoder-306723';
    const location = 'us-central1';
    const apiKey = process.env.GOOGLE_CLOUD_API_KEY;

    const imagenResponse = await fetch(
      `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/imagen-3.0-capability-001:predict?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          instances: [
            {
              prompt: prompt,
              referenceImages: [
                {
                  referenceType: 'REFERENCE_TYPE_RAW',
                  referenceId: 1,
                  referenceImage: {
                    bytesBase64Encoded: base64Image
                  }
                }
              ]
            }
          ],
          parameters: {
            sampleCount: 1
          }
        })
      }
    );

    if (!imagenResponse.ok) {
      const errorText = await imagenResponse.text();
      console.error('Imagen API error:', imagenResponse.status, errorText);
      throw new Error(`Imagen API error: ${errorText}`);
    }

    const imagenResult = await imagenResponse.json();
    console.log('Google Imagen result received successfully');

    // Get the generated image from the response
    const generatedBase64 = imagenResult.predictions[0].bytesBase64Encoded;
    const resultBuffer = Buffer.from(generatedBase64, 'base64');

    // Store the generated image in Supabase
    const fileName = `generated/${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from('visualizer-images')
      .upload(fileName, resultBuffer, {
        contentType: 'image/jpeg',
        upsert: false
      });

    if (uploadError) {
      console.error('Error storing generated image:', uploadError);
      // Return base64 image if storage fails
      const base64Url = `data:image/jpeg;base64,${resultBuffer.toString('base64')}`;
      return res.json({
        success: true,
        originalUrl: imageUrl,
        generatedUrl: base64Url,
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
