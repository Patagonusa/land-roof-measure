let map;
let drawingManager;
let landPolygons = [];
let roofPolygons = [];
let currentMode = null;
let selectedPolygon = null;
let addressMarker = null;

// Initialize the app
async function init() {
  // Fetch config from server
  const configResponse = await fetch('/api/config');
  const config = await configResponse.json();

  // Set up error handler for Maps API
  window.gm_authFailure = function() {
    const mapDiv = document.getElementById('map');
    mapDiv.innerHTML = `
      <div style="padding: 40px; text-align: center; background: #fff3cd; height: 100%; display: flex; flex-direction: column; justify-content: center; align-items: center;">
        <h2 style="color: #856404; margin-bottom: 20px;">Google Maps API Key Error</h2>
        <p style="color: #856404; max-width: 500px; line-height: 1.6;">
          The API key needs to be configured in Google Cloud Console:<br><br>
          1. Go to <a href="https://console.cloud.google.com/apis/library" target="_blank">Google Cloud Console</a><br>
          2. Enable "Maps JavaScript API"<br>
          3. Enable "Geocoding API"<br>
          4. Check API key restrictions allow this domain
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
        fillColor: '#27ae60',
        strokeColor: '#27ae60'
      });
      landPolygons.push(polygon);
    } else if (currentMode === 'roof') {
      polygon.setOptions({
        fillColor: '#e74c3c',
        strokeColor: '#e74c3c'
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

    // Stop drawing after completing a polygon
    drawingManager.setDrawingMode(null);
    updateAreas();
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
  document.getElementById('clear-btn').addEventListener('click', clearAll);

  // Pitch selector
  document.getElementById('roof-pitch').addEventListener('change', updateAreas);

  // Keyboard listener for delete
  document.addEventListener('keydown', function(e) {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedPolygon) {
      deleteSelectedPolygon();
    }
    if (e.key === 'Escape') {
      drawingManager.setDrawingMode(null);
      deselectPolygon();
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
          fillColor: '#3498db',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 3
        }
      });

      // Add info window with address
      const infoWindow = new google.maps.InfoWindow({
        content: `<div style="font-weight: bold; padding: 5px;">${formattedAddress}</div>`
      });

      addressMarker.addListener('click', () => {
        infoWindow.open(map, addressMarker);
      });

      // Auto-open info window briefly
      infoWindow.open(map, addressMarker);
      setTimeout(() => infoWindow.close(), 3000);

    } else {
      alert('Address not found. Please try a different address.');
    }
  } catch (error) {
    console.error('Search error:', error);
    alert('Error searching for address. Please try again.');
  }
}

function setDrawingMode(mode) {
  currentMode = mode;
  deselectPolygon();

  const options = {
    fillOpacity: 0.3,
    strokeWeight: 2,
    editable: true,
    draggable: true
  };

  if (mode === 'land') {
    options.fillColor = '#27ae60';
    options.strokeColor = '#27ae60';
  } else if (mode === 'roof') {
    options.fillColor = '#e74c3c';
    options.strokeColor = '#e74c3c';
  }

  drawingManager.setOptions({ polygonOptions: options });
  drawingManager.setDrawingMode(google.maps.drawing.OverlayType.POLYGON);
  updateButtonStates();
}

function updateButtonStates() {
  document.getElementById('land-btn').classList.toggle('active', currentMode === 'land');
  document.getElementById('roof-btn').classList.toggle('active', currentMode === 'roof');
}

function selectPolygon(polygon) {
  deselectPolygon();
  selectedPolygon = polygon;
  polygon.setOptions({ strokeWeight: 4 });
}

function deselectPolygon() {
  if (selectedPolygon) {
    selectedPolygon.setOptions({ strokeWeight: 2 });
    selectedPolygon = null;
  }
}

function deleteSelectedPolygon() {
  if (!selectedPolygon) return;

  // Remove from appropriate array
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
}

function clearAll() {
  landPolygons.forEach(p => p.setMap(null));
  roofPolygons.forEach(p => p.setMap(null));
  landPolygons = [];
  roofPolygons = [];
  selectedPolygon = null;
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

function updateAreas() {
  const landAreaM2 = calculateTotalArea(landPolygons);
  const roofAreaM2 = calculateTotalArea(roofPolygons);

  // Convert to square feet (1 m² = 10.7639 sq ft)
  const landAreaSqFt = landAreaM2 * 10.7639;
  const roofAreaSqFt = roofAreaM2 * 10.7639;

  // Get pitch multiplier
  const pitchMultiplier = parseFloat(document.getElementById('roof-pitch').value);
  const adjustedRoofSqFt = roofAreaSqFt * pitchMultiplier;
  const adjustedRoofM2 = roofAreaM2 * pitchMultiplier;

  // Update display
  document.getElementById('land-area').textContent = formatNumber(landAreaSqFt);
  document.getElementById('land-area-m2').textContent = formatNumber(landAreaM2);
  document.getElementById('land-count').textContent = landPolygons.length;
  document.getElementById('roof-area').textContent = formatNumber(roofAreaSqFt);
  document.getElementById('roof-area-m2').textContent = formatNumber(roofAreaM2);
  document.getElementById('roof-count').textContent = roofPolygons.length;
  document.getElementById('roof-area-adjusted').textContent = formatNumber(adjustedRoofSqFt);
  document.getElementById('roof-area-adjusted-m2').textContent = formatNumber(adjustedRoofM2);
}

function formatNumber(num) {
  return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// Start the app
init();
