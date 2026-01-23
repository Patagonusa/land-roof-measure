let map;
let drawingManager;
let landPolygons = [];
let roofPolygons = [];
let currentMode = null;
let selectedPolygon = null;
let addressMarker = null;
let streetViewPanorama = null;
let streetViewService = null;
let isStreetViewActive = false;

// Patagon Consulting Brand Colors
const COLORS = {
  land: '#2563EB',      // Royal Blue
  roof: '#1E3A5F',      // Mountain Blue
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
    if (currentMode) {
      setTimeout(() => {
        drawingManager.setDrawingMode(google.maps.drawing.OverlayType.POLYGON);
      }, 100);
    }

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
  document.getElementById('streetview-btn').addEventListener('click', toggleStreetView);
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

  const options = {
    fillOpacity: 0.3,
    strokeWeight: 2,
    editable: true,
    draggable: true
  };

  if (mode === 'land') {
    options.fillColor = COLORS.land;
    options.strokeColor = COLORS.land;
  } else if (mode === 'roof') {
    options.fillColor = COLORS.roof;
    options.strokeColor = COLORS.roof;
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
  // Clear all polygons from map
  landPolygons.forEach(p => {
    google.maps.event.clearInstanceListeners(p);
    p.setMap(null);
  });
  roofPolygons.forEach(p => {
    google.maps.event.clearInstanceListeners(p);
    p.setMap(null);
  });
  landPolygons = [];
  roofPolygons = [];
  selectedPolygon = null;

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
}

function formatNumber(num) {
  return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// Start the app
init();
