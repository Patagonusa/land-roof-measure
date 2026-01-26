let map;
let drawingManager;
let landPolygons = [];
let roofPolygons = [];
let fencePolylines = [];
let currentMode = null;
let selectedPolygon = null;
let selectedPolyline = null;
let addressMarker = null;
let streetViewPanorama = null;
let streetViewService = null;
let isStreetViewActive = false;

// Patagon Consulting Brand Colors
const COLORS = {
  land: '#2563EB',      // Royal Blue
  roof: '#1E3A5F',      // Mountain Blue
  fence: '#059669',     // Emerald Green
  marker: '#3B82F6',    // Sky Blue
  markerBorder: '#FFFFFF'
};

// Initialize the app
async function init() {
  // Fetch config from server
  const configResponse = await fetch('/api/config');
  const config = await configResponse.json();

  // Set up error handler for Maps API
  window.gm_authFailure = function() {
    const mapDiv = document.getElementById('map');
    mapDiv.innerHTML = `
      <div style="padding: 40px; text-align: center; background: #F0F9FF; height: 100%; display: flex; flex-direction: column; justify-content: center; align-items: center;">
        <h2 style="color: #1E3A5F; margin-bottom: 20px;">Error de API Key de Google Maps</h2>
        <p style="color: #0A1628; max-width: 500px; line-height: 1.6;">
          La clave API necesita ser configurada en Google Cloud Console:<br><br>
          1. Ir a <a href="https://console.cloud.google.com/apis/library" target="_blank" style="color: #2563EB;">Google Cloud Console</a><br>
          2. Habilitar "Maps JavaScript API"<br>
          3. Habilitar "Geocoding API"<br>
          4. Habilitar "Street View Static API"<br>
          5. Verificar que las restricciones de la clave permitan este dominio
        </p>
      </div>
    `;
  };

  // Load Google Maps script with async loading
  const script = document.createElement('script');
  script.src = `https://maps.googleapis.com/maps/api/js?key=${config.mapsApiKey}&libraries=drawing,geometry&loading=async&callback=initMap`;
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
}

// Initialize the map
function initMap() {
  map = new google.maps.Map(document.getElementById('map'), {
    center: { lat: 39.8283, lng: -98.5795 }, // Center of USA
    zoom: 5,
    mapTypeId: 'satellite',
    tilt: 0
  });

  // Initialize Street View Service
  streetViewService = new google.maps.StreetViewService();

  // Initialize Street View Panorama
  streetViewPanorama = new google.maps.StreetViewPanorama(
    document.getElementById('streetview-container'),
    {
      enableCloseButton: false,
      addressControl: true,
      linksControl: true,
      panControl: true,
      zoomControl: true,
      fullscreenControl: true
    }
  );

  // Link map and street view
  map.setStreetView(streetViewPanorama);

  // Initialize drawing manager
  drawingManager = new google.maps.drawing.DrawingManager({
    drawingMode: null,
    drawingControl: false,
    polygonOptions: {
      fillOpacity: 0.3,
      strokeWeight: 2,
      editable: true,
      draggable: true
    }
  });
  drawingManager.setMap(map);

  // Handle polygon complete
  google.maps.event.addListener(drawingManager, 'polygoncomplete', function(polygon) {
    if (currentMode === 'land') {
      polygon.setOptions({
        fillColor: COLORS.land,
        strokeColor: COLORS.land
      });
      landPolygons.push(polygon);
    } else if (currentMode === 'roof') {
      polygon.setOptions({
        fillColor: COLORS.roof,
        strokeColor: COLORS.roof
      });
      roofPolygons.push(polygon);
    }

    // Add click listener for selection
    google.maps.event.addListener(polygon, 'click', function() {
      selectPolygon(polygon);
    });

    // Add path change listeners for area recalculation
    google.maps.event.addListener(polygon.getPath(), 'set_at', updateAreas);
    google.maps.event.addListener(polygon.getPath(), 'insert_at', updateAreas);
    google.maps.event.addListener(polygon.getPath(), 'remove_at', updateAreas);

    // Keep drawing mode active so user can draw more sections
    // Re-enable polygon drawing in the same mode
    if (currentMode && currentMode !== 'fence') {
      setTimeout(() => {
        drawingManager.setDrawingMode(google.maps.drawing.OverlayType.POLYGON);
      }, 100);
    }

    updateAreas();
  });

  // Handle polyline complete (for fence/wall measurement)
  google.maps.event.addListener(drawingManager, 'polylinecomplete', function(polyline) {
    if (currentMode === 'fence') {
      polyline.setOptions({
        strokeColor: COLORS.fence,
        strokeWeight: 4
      });
      fencePolylines.push(polyline);

      // Add click listener for selection
      google.maps.event.addListener(polyline, 'click', function() {
        selectPolyline(polyline);
      });

      // Add path change listeners for distance recalculation
      google.maps.event.addListener(polyline.getPath(), 'set_at', updateAreas);
      google.maps.event.addListener(polyline.getPath(), 'insert_at', updateAreas);
      google.maps.event.addListener(polyline.getPath(), 'remove_at', updateAreas);

      // Keep drawing mode active for more lines
      setTimeout(() => {
        drawingManager.setDrawingMode(google.maps.drawing.OverlayType.POLYLINE);
      }, 100);

      updateAreas();
    }
  });

  // Setup event listeners
  setupEventListeners();
}

function setupEventListeners() {
  // Search button
  document.getElementById('search-btn').addEventListener('click', searchAddress);
  document.getElementById('address-input').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') searchAddress();
  });

  // Tool buttons
  document.getElementById('land-btn').addEventListener('click', () => setDrawingMode('land'));
  document.getElementById('roof-btn').addEventListener('click', () => setDrawingMode('roof'));
  document.getElementById('fence-btn').addEventListener('click', () => setDrawingMode('fence'));
  document.getElementById('streetview-btn').addEventListener('click', toggleStreetView);
  document.getElementById('clear-btn').addEventListener('click', clearAll);

  // Pitch selector
  document.getElementById('roof-pitch').addEventListener('change', updateAreas);

  // Keyboard listener for delete
  document.addEventListener('keydown', function(e) {
    if ((e.key === 'Delete' || e.key === 'Backspace') && (selectedPolygon || selectedPolyline)) {
      deleteSelectedPolygon();
    }
    if (e.key === 'Escape') {
      drawingManager.setDrawingMode(null);
      deselectPolygon();
      deselectPolyline();
      updateButtonStates();
    }
  });
}

async function searchAddress() {
  const address = document.getElementById('address-input').value.trim();
  if (!address) return;

  try {
    const response = await fetch(`/api/geocode?address=${encodeURIComponent(address)}`);
    const data = await response.json();

    if (data.results && data.results.length > 0) {
      const location = data.results[0].geometry.location;
      const formattedAddress = data.results[0].formatted_address;

      map.setCenter(location);
      map.setZoom(20); // High zoom for property view
      map.setTilt(0); // Top-down view for accurate measurement

      // Remove previous marker if exists
      if (addressMarker) {
        addressMarker.setMap(null);
      }

      // Add marker pin at the address
      addressMarker = new google.maps.Marker({
        position: location,
        map: map,
        title: formattedAddress,
        animation: google.maps.Animation.DROP,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 12,
          fillColor: COLORS.marker,
          fillOpacity: 1,
          strokeColor: COLORS.markerBorder,
          strokeWeight: 3
        }
      });

      // Add info window with address
      const infoWindow = new google.maps.InfoWindow({
        content: `<div style="font-weight: bold; padding: 5px; color: #0A1628;">${formattedAddress}</div>`
      });

      addressMarker.addListener('click', () => {
        infoWindow.open(map, addressMarker);
      });

      // Auto-open info window briefly
      infoWindow.open(map, addressMarker);
      setTimeout(() => infoWindow.close(), 3000);

      // Update Street View to this location if active
      if (isStreetViewActive) {
        updateStreetView(location);
      }

    } else {
      alert('Direccion no encontrada. Por favor intente con otra direccion.');
    }
  } catch (error) {
    console.error('Error de busqueda:', error);
    alert('Error al buscar la direccion. Por favor intente de nuevo.');
  }
}

function toggleStreetView() {
  isStreetViewActive = !isStreetViewActive;
  const streetViewContainer = document.getElementById('streetview-container');
  const mapContainer = document.getElementById('map');
  const streetViewBtn = document.getElementById('streetview-btn');

  if (isStreetViewActive) {
    streetViewContainer.classList.add('active');
    mapContainer.classList.add('with-streetview');
    streetViewBtn.classList.add('active');

    // Get current map center for street view
    const center = map.getCenter();
    updateStreetView({ lat: center.lat(), lng: center.lng() });
  } else {
    streetViewContainer.classList.remove('active');
    mapContainer.classList.remove('with-streetview');
    streetViewBtn.classList.remove('active');
  }
}

function updateStreetView(location) {
  if (!streetViewService || !streetViewPanorama) return;

  streetViewService.getPanorama(
    { location: location, radius: 50 },
    function(data, status) {
      if (status === google.maps.StreetViewStatus.OK) {
        streetViewPanorama.setPano(data.location.pano);
        streetViewPanorama.setPov({
          heading: 0,
          pitch: 0
        });
        streetViewPanorama.setVisible(true);
      } else {
        console.log('Street View not available for this location');
        // Show message in street view container
        const container = document.getElementById('streetview-container');
        if (isStreetViewActive) {
          container.innerHTML = `
            <div style="height: 100%; display: flex; align-items: center; justify-content: center; background: #F0F9FF; color: #1E3A5F; text-align: center; padding: 20px;">
              <div>
                <p style="font-size: 1.1rem; font-weight: 600;">Street View no disponible</p>
                <p style="font-size: 0.9rem; margin-top: 10px; color: #60A5FA;">No hay cobertura de Street View para esta ubicacion.</p>
              </div>
            </div>
          `;
        }
      }
    }
  );
}

function setDrawingMode(mode) {
  currentMode = mode;
  deselectPolygon();
  deselectPolyline();

  if (mode === 'fence') {
    // Use polyline for fence/wall distance measurement
    const polylineOptions = {
      strokeColor: COLORS.fence,
      strokeWeight: 4,
      editable: true,
      draggable: true
    };
    drawingManager.setOptions({ polylineOptions: polylineOptions });
    drawingManager.setDrawingMode(google.maps.drawing.OverlayType.POLYLINE);
  } else {
    // Use polygon for area measurement (land/roof)
    const polygonOptions = {
      fillOpacity: 0.3,
      strokeWeight: 2,
      editable: true,
      draggable: true
    };

    if (mode === 'land') {
      polygonOptions.fillColor = COLORS.land;
      polygonOptions.strokeColor = COLORS.land;
    } else if (mode === 'roof') {
      polygonOptions.fillColor = COLORS.roof;
      polygonOptions.strokeColor = COLORS.roof;
    }

    drawingManager.setOptions({ polygonOptions: polygonOptions });
    drawingManager.setDrawingMode(google.maps.drawing.OverlayType.POLYGON);
  }
  updateButtonStates();
}

function updateButtonStates() {
  document.getElementById('land-btn').classList.toggle('active', currentMode === 'land');
  document.getElementById('roof-btn').classList.toggle('active', currentMode === 'roof');
  document.getElementById('fence-btn').classList.toggle('active', currentMode === 'fence');
}

function selectPolygon(polygon) {
  deselectPolygon();
  deselectPolyline();
  selectedPolygon = polygon;
  polygon.setOptions({ strokeWeight: 4 });
}

function deselectPolygon() {
  if (selectedPolygon) {
    selectedPolygon.setOptions({ strokeWeight: 2 });
    selectedPolygon = null;
  }
}

function selectPolyline(polyline) {
  deselectPolygon();
  deselectPolyline();
  selectedPolyline = polyline;
  polyline.setOptions({ strokeWeight: 6 });
}

function deselectPolyline() {
  if (selectedPolyline) {
    selectedPolyline.setOptions({ strokeWeight: 4 });
    selectedPolyline = null;
  }
}

function deleteSelectedPolygon() {
  // Handle polygon deletion
  if (selectedPolygon) {
    let index = landPolygons.indexOf(selectedPolygon);
    if (index > -1) {
      landPolygons.splice(index, 1);
    } else {
      index = roofPolygons.indexOf(selectedPolygon);
      if (index > -1) {
        roofPolygons.splice(index, 1);
      }
    }
    selectedPolygon.setMap(null);
    selectedPolygon = null;
    updateAreas();
    return;
  }

  // Handle polyline deletion (fence/wall)
  if (selectedPolyline) {
    const index = fencePolylines.indexOf(selectedPolyline);
    if (index > -1) {
      fencePolylines.splice(index, 1);
    }
    selectedPolyline.setMap(null);
    selectedPolyline = null;
    updateAreas();
  }
}

function clearAll() {
  // Clear all polygons from map
  landPolygons.forEach(p => {
    google.maps.event.clearInstanceListeners(p);
    p.setMap(null);
  });
  roofPolygons.forEach(p => {
    google.maps.event.clearInstanceListeners(p);
    p.setMap(null);
  });
  // Clear all fence polylines from map
  fencePolylines.forEach(p => {
    google.maps.event.clearInstanceListeners(p);
    p.setMap(null);
  });
  landPolygons = [];
  roofPolygons = [];
  fencePolylines = [];
  selectedPolygon = null;
  selectedPolyline = null;

  // Reset drawing mode so user can start fresh
  currentMode = null;
  drawingManager.setDrawingMode(null);

  // Re-attach drawing manager to map to ensure it works
  drawingManager.setMap(null);
  drawingManager.setMap(map);

  updateButtonStates();
  updateAreas();
}

function calculateTotalArea(polygons) {
  let totalArea = 0;
  polygons.forEach(polygon => {
    const area = google.maps.geometry.spherical.computeArea(polygon.getPath());
    totalArea += area;
  });
  return totalArea; // in square meters
}

function calculateTotalLength(polylines) {
  let totalLength = 0;
  polylines.forEach(polyline => {
    const length = google.maps.geometry.spherical.computeLength(polyline.getPath());
    totalLength += length;
  });
  return totalLength; // in meters
}

function updateAreas() {
  const landAreaM2 = calculateTotalArea(landPolygons);
  const roofAreaM2 = calculateTotalArea(roofPolygons);
  const fenceLengthM = calculateTotalLength(fencePolylines);

  // Convert to square feet (1 m² = 10.7639 sq ft)
  const landAreaSqFt = landAreaM2 * 10.7639;
  const roofAreaSqFt = roofAreaM2 * 10.7639;

  // Convert to feet (1 m = 3.28084 ft)
  const fenceLengthFt = fenceLengthM * 3.28084;

  // Get pitch multiplier
  const pitchMultiplier = parseFloat(document.getElementById('roof-pitch').value);
  const adjustedRoofSqFt = roofAreaSqFt * pitchMultiplier;
  const adjustedRoofM2 = roofAreaM2 * pitchMultiplier;

  // Calculate roofing squares (1 square = 100 sq ft)
  const roofSquares = adjustedRoofSqFt / 100;

  // Update display
  document.getElementById('land-area').textContent = formatNumber(landAreaSqFt);
  document.getElementById('land-area-m2').textContent = formatNumber(landAreaM2);
  document.getElementById('land-count').textContent = landPolygons.length;
  document.getElementById('roof-area').textContent = formatNumber(roofAreaSqFt);
  document.getElementById('roof-area-m2').textContent = formatNumber(roofAreaM2);
  document.getElementById('roof-count').textContent = roofPolygons.length;
  document.getElementById('roof-area-adjusted').textContent = formatNumber(adjustedRoofSqFt);
  document.getElementById('roof-area-adjusted-m2').textContent = formatNumber(adjustedRoofM2);
  document.getElementById('roof-squares').textContent = formatNumber(roofSquares);

  // Update fence/wall distance display
  document.getElementById('fence-length').textContent = formatNumber(fenceLengthFt);
  document.getElementById('fence-length-m').textContent = formatNumber(fenceLengthM);
  document.getElementById('fence-count').textContent = fencePolylines.length;
}

function formatNumber(num) {
  return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// Start the app
init();

// ============================================
// VISUALIZER FUNCTIONALITY
// ============================================

let uploadedImageUrl = null;
let selectedVizType = 'paint';
let selectedPaintColor = 'white';
let selectedFenceMaterial = 'vinyl';
let selectedFenceStyle = 'white';
let selectedRoofColor = 'charcoal gray';
let generatedImageUrl = null;
let visualizationHistory = [];

// Load history from localStorage
function loadHistory() {
  const saved = localStorage.getItem('visualizationHistory');
  if (saved) {
    visualizationHistory = JSON.parse(saved);
    renderHistory();
  }
}

// Save history to localStorage
function saveHistory() {
  localStorage.setItem('visualizationHistory', JSON.stringify(visualizationHistory));
}

// Initialize visualizer when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
  setupTabNavigation();
  setupVisualizerEvents();
});

// Tab Navigation
function setupTabNavigation() {
  const tabBtns = document.querySelectorAll('.tab-navigation .tab-btn');
  const mainContent = document.querySelector('.main-content');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', function() {
      const tabId = this.dataset.tab;

      // Update active tab button
      tabBtns.forEach(b => b.classList.remove('active'));
      this.classList.add('active');

      // Show corresponding tab content
      document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
      });

      const targetTab = document.getElementById(`${tabId}-tab`);
      if (targetTab) {
        targetTab.classList.add('active');
      }

      // Toggle visualizer mode (hides map, expands interface)
      if (tabId === 'visualizer') {
        mainContent.classList.add('visualizer-mode');
      } else {
        mainContent.classList.remove('visualizer-mode');
      }
    });
  });
}

// Visualizer Event Handlers
function setupVisualizerEvents() {
  // Image upload via file input
  const imageInput = document.getElementById('image-input');
  if (imageInput) {
    imageInput.addEventListener('change', handleImageSelect);
  }

  // Drag and drop
  const uploadArea = document.getElementById('upload-area');
  if (uploadArea) {
    uploadArea.addEventListener('dragover', handleDragOver);
    uploadArea.addEventListener('dragleave', handleDragLeave);
    uploadArea.addEventListener('drop', handleDrop);
  }

  // Remove image button
  const removeBtn = document.getElementById('remove-image');
  if (removeBtn) {
    removeBtn.addEventListener('click', removeImage);
  }

  // Visualization type radio buttons
  const vizTypeRadios = document.querySelectorAll('input[name="viz-type"]');
  vizTypeRadios.forEach(radio => {
    radio.addEventListener('change', handleVizTypeChange);
  });

  // Paint color swatches
  const paintSwatches = document.querySelectorAll('#paint-options .color-swatch');
  paintSwatches.forEach(swatch => {
    swatch.addEventListener('click', function() {
      paintSwatches.forEach(s => s.classList.remove('selected'));
      this.classList.add('selected');
      selectedPaintColor = this.dataset.color;
    });
  });

  // Fence options
  const fenceOptions = document.querySelectorAll('.fence-option');
  fenceOptions.forEach(option => {
    option.addEventListener('click', function() {
      fenceOptions.forEach(o => o.classList.remove('selected'));
      this.classList.add('selected');
      selectedFenceMaterial = this.dataset.material;
      selectedFenceStyle = this.dataset.style;
    });
  });

  // Roof color swatches
  const roofSwatches = document.querySelectorAll('#roof-options .color-swatch');
  roofSwatches.forEach(swatch => {
    swatch.addEventListener('click', function() {
      roofSwatches.forEach(s => s.classList.remove('selected'));
      this.classList.add('selected');
      selectedRoofColor = this.dataset.color;
    });
  });

  // Generate button
  const generateBtn = document.getElementById('generate-btn');
  if (generateBtn) {
    generateBtn.addEventListener('click', generateVisualization);
  }

  // Download button
  const downloadBtn = document.getElementById('download-btn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', downloadResult);
  }

  // Save to history button
  const saveHistoryBtn = document.getElementById('save-history-btn');
  if (saveHistoryBtn) {
    saveHistoryBtn.addEventListener('click', saveToHistory);
  }

  // Clear history button
  const clearHistoryBtn = document.getElementById('clear-history-btn');
  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', clearHistory);
  }

  // Load existing history
  loadHistory();
}

// Handle drag over
function handleDragOver(e) {
  e.preventDefault();
  e.stopPropagation();
  this.classList.add('dragover');
}

// Handle drag leave
function handleDragLeave(e) {
  e.preventDefault();
  e.stopPropagation();
  this.classList.remove('dragover');
}

// Handle drop
function handleDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  this.classList.remove('dragover');

  const files = e.dataTransfer.files;
  if (files.length > 0 && files[0].type.startsWith('image/')) {
    uploadImage(files[0]);
  }
}

// Handle file select
function handleImageSelect(e) {
  const files = e.target.files;
  if (files.length > 0) {
    uploadImage(files[0]);
  }
}

// Upload image to server
async function uploadImage(file) {
  const uploadArea = document.getElementById('upload-area');
  const imagePreview = document.getElementById('image-preview');
  const previewImg = document.getElementById('preview-img');
  const generateBtn = document.getElementById('generate-btn');

  // Show loading state
  uploadArea.innerHTML = '<div class="upload-icon">⏳</div><p>Subiendo imagen...</p>';

  try {
    const formData = new FormData();
    formData.append('image', file);

    const response = await fetch('/api/upload-image', {
      method: 'POST',
      body: formData
    });

    const result = await response.json();

    if (result.success) {
      uploadedImageUrl = result.url;

      // Show preview
      previewImg.src = uploadedImageUrl;
      uploadArea.style.display = 'none';
      imagePreview.style.display = 'block';

      // Enable generate button
      generateBtn.disabled = false;
    } else {
      throw new Error(result.error || 'Upload failed');
    }
  } catch (error) {
    console.error('Upload error:', error);
    alert('Error al subir la imagen. Por favor intente de nuevo.');

    // Reset upload area
    uploadArea.innerHTML = `
      <div class="upload-icon">📷</div>
      <p>Arrastra una imagen aqui o</p>
      <label class="upload-btn">
        Seleccionar Archivo
        <input type="file" id="image-input" accept="image/*" hidden>
      </label>
    `;
    document.getElementById('image-input').addEventListener('change', handleImageSelect);
  }
}

// Remove uploaded image
function removeImage() {
  uploadedImageUrl = null;
  generatedImageUrl = null;

  const uploadArea = document.getElementById('upload-area');
  const imagePreview = document.getElementById('image-preview');
  const generateBtn = document.getElementById('generate-btn');
  const vizResults = document.getElementById('viz-results');

  // Reset upload area
  uploadArea.style.display = 'block';
  uploadArea.innerHTML = `
    <div class="upload-icon">📷</div>
    <p>Arrastra una imagen aqui o</p>
    <label class="upload-btn">
      Seleccionar Archivo
      <input type="file" id="image-input" accept="image/*" hidden>
    </label>
  `;
  document.getElementById('image-input').addEventListener('change', handleImageSelect);

  // Hide preview and results
  imagePreview.style.display = 'none';
  vizResults.style.display = 'none';

  // Disable generate button
  generateBtn.disabled = true;
}

// Handle visualization type change
function handleVizTypeChange(e) {
  selectedVizType = e.target.value;

  // Show/hide appropriate options
  document.getElementById('paint-options').style.display = selectedVizType === 'paint' ? 'block' : 'none';
  document.getElementById('fence-options').style.display = selectedVizType === 'fence' ? 'block' : 'none';
  document.getElementById('roof-options').style.display = selectedVizType === 'roof' ? 'block' : 'none';
}

// Generate visualization
async function generateVisualization() {
  if (!uploadedImageUrl) {
    alert('Por favor suba una imagen primero.');
    return;
  }

  const generateBtn = document.getElementById('generate-btn');
  const generateText = generateBtn.querySelector('.generate-text');
  const generateLoading = generateBtn.querySelector('.generate-loading');

  // Show loading state
  generateBtn.disabled = true;
  generateText.style.display = 'none';
  generateLoading.style.display = 'flex';

  try {
    // Build options based on type
    let options = {};

    if (selectedVizType === 'paint') {
      options = { color: selectedPaintColor };
    } else if (selectedVizType === 'fence') {
      options = { material: selectedFenceMaterial, style: selectedFenceStyle };
    } else if (selectedVizType === 'roof') {
      options = { color: selectedRoofColor };
    }

    const response = await fetch('/api/visualize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageUrl: uploadedImageUrl,
        type: selectedVizType,
        options: options
      })
    });

    const result = await response.json();

    if (result.success) {
      generatedImageUrl = result.generatedUrl;

      // Show results
      document.getElementById('result-original').src = uploadedImageUrl;
      document.getElementById('result-generated').src = generatedImageUrl;
      document.getElementById('viz-results').style.display = 'block';

      // Scroll to results
      document.getElementById('viz-results').scrollIntoView({ behavior: 'smooth' });
    } else {
      throw new Error(result.error || 'Generation failed');
    }
  } catch (error) {
    console.error('Visualization error:', error);
    alert('Error al generar la visualizacion: ' + error.message);
  } finally {
    // Reset button state
    generateBtn.disabled = false;
    generateText.style.display = 'inline';
    generateLoading.style.display = 'none';
  }
}

// Download generated result
function downloadResult() {
  if (!generatedImageUrl) return;

  // Create a temporary link and trigger download
  const link = document.createElement('a');
  link.href = generatedImageUrl;
  link.download = `visualizacion-${Date.now()}.png`;
  link.target = '_blank';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Save current result to history
function saveToHistory() {
  if (!generatedImageUrl || !uploadedImageUrl) {
    alert('No hay visualizacion para guardar.');
    return;
  }

  // Get the current visualization details
  let colorOrStyle = '';
  if (selectedVizType === 'paint') {
    colorOrStyle = selectedPaintColor;
  } else if (selectedVizType === 'fence') {
    colorOrStyle = `${selectedFenceMaterial} ${selectedFenceStyle}`;
  } else if (selectedVizType === 'roof') {
    colorOrStyle = selectedRoofColor;
  }

  const historyItem = {
    id: Date.now(),
    type: selectedVizType,
    color: colorOrStyle,
    originalUrl: uploadedImageUrl,
    generatedUrl: generatedImageUrl,
    timestamp: new Date().toLocaleString()
  };

  visualizationHistory.unshift(historyItem);

  // Keep only last 20 items
  if (visualizationHistory.length > 20) {
    visualizationHistory = visualizationHistory.slice(0, 20);
  }

  saveHistory();
  renderHistory();

  alert('Guardado en historial!');
}

// Render history grid
function renderHistory() {
  const historySection = document.getElementById('viz-history');
  const historyGrid = document.getElementById('history-grid');

  if (visualizationHistory.length === 0) {
    historySection.style.display = 'none';
    return;
  }

  historySection.style.display = 'block';
  historyGrid.innerHTML = '';

  visualizationHistory.forEach(item => {
    const div = document.createElement('div');
    div.className = 'history-item';
    div.dataset.id = item.id;
    div.innerHTML = `
      <img src="${item.generatedUrl}" alt="Visualization">
      <div class="history-item-info">
        <div class="history-item-type">${getTypeLabel(item.type)}</div>
        <div class="history-item-color">${item.color}</div>
      </div>
      <button class="history-item-delete" onclick="deleteHistoryItem(${item.id}); event.stopPropagation();">x</button>
    `;

    // Click to view full size
    div.addEventListener('click', () => viewHistoryItem(item));

    historyGrid.appendChild(div);
  });
}

// Get display label for type
function getTypeLabel(type) {
  const labels = {
    'paint': 'Pintura',
    'fence': 'Cerca',
    'roof': 'Techo'
  };
  return labels[type] || type;
}

// View history item in main result area
function viewHistoryItem(item) {
  document.getElementById('result-original').src = item.originalUrl;
  document.getElementById('result-generated').src = item.generatedUrl;
  document.getElementById('viz-results').style.display = 'block';
  generatedImageUrl = item.generatedUrl;

  // Highlight selected item
  document.querySelectorAll('.history-item').forEach(el => el.classList.remove('selected'));
  document.querySelector(`.history-item[data-id="${item.id}"]`)?.classList.add('selected');

  // Scroll to results
  document.getElementById('viz-results').scrollIntoView({ behavior: 'smooth' });
}

// Delete single history item
function deleteHistoryItem(id) {
  visualizationHistory = visualizationHistory.filter(item => item.id !== id);
  saveHistory();
  renderHistory();
}

// Clear all history
function clearHistory() {
  if (confirm('Estas seguro de borrar todo el historial?')) {
    visualizationHistory = [];
    saveHistory();
    renderHistory();
  }
}
