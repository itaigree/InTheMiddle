// Runtime configuration. The deploy workflow (.github/workflows/deploy.yml) overwrites
// this file with values from the repository's secrets and variables.
// With no Google key the app runs in the free OpenStreetMap mode.
window.APP_CONFIG = {
  googleMapsApiKey: '',
  googleMapId: '',
  // The share service (worker/share.js) that keeps free results for shared links.
  shareApiUrl: '',
};
