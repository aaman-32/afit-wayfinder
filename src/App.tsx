import { useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';

maplibregl.setWorkerUrl(maplibreWorkerUrl);

interface PoiProperties {
  id: string;
  name: string;
  category: string;
  description: string;
}

async function safeLoadGeoJson(url: string) {
  try {
    const res = await fetch(url);
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok || !contentType.includes('json')) {
      console.warn(`Skipping ${url}: file not found in public/`);
      return { type: 'FeatureCollection', features: [] };
    }
    return await res.json();
  } catch (err) {
    console.warn(`Failed to load ${url}:`, err);
    return { type: 'FeatureCollection', features: [] };
  }
}

export default function App() {
  const mapContainer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mapContainer.current) return;
    let map: maplibregl.Map | null = null;
    let isMounted = true;

    async function initMap() {
      const [buildingsData, poisData] = await Promise.all([
        safeLoadGeoJson('/data/buildings.geojson'),
        safeLoadGeoJson('/data/campus.json'),
      ]);

      if (!isMounted || !mapContainer.current) return;

      map = new maplibregl.Map({
        container: mapContainer.current,
        center: [7.4428, 10.6105],
        zoom: 16,
        pitch: 50,
        bearing: -15,
        style: {
          version: 8,
          sources: {
            buildings: { type: 'geojson', data: buildingsData },
            pois: { type: 'geojson', data: poisData },
          },
          layers: [
            {
              id: 'ground',
              type: 'background',
              paint: { 'background-color': '#eef0eb' },
            },
            {
              id: 'roads',
              type: 'line',
              source: 'buildings',
              filter: ['has', 'highway'],
              paint: {
                'line-color': '#ffffff',
                'line-width': 4,
              },
            },
            {
              id: 'buildings-3d',
              type: 'fill-extrusion',
              source: 'buildings',
              filter: ['has', 'building'],
              paint: {
                'fill-extrusion-color': '#d6cfc7',
                'fill-extrusion-height': [
                  'case',
                  ['has', 'height'],
                  ['to-number', ['get', 'height'], 10],
                  ['has', 'building:levels'],
                  ['*', ['to-number', ['get', 'building:levels'], 3], 3.5],
                  10,
                ],
                'fill-extrusion-base': 0,
                'fill-extrusion-opacity': 0.92,
              },
            },
            {
              id: 'poi-circles',
              type: 'circle',
              source: 'pois',
              paint: {
                'circle-radius': 8,
                'circle-stroke-width': 2,
                'circle-stroke-color': '#ffffff',
                'circle-color': [
                  'match',
                  ['get', 'category'],
                  'academic', '#2563eb',
                  'food', '#ea580c',
                  'housing', '#7c3aed',
                  'community', '#16a34a',
                  'recreation', '#0891b2',
                  'administration', '#dc2626',
                  '#475569',
                ],
              },
            },
          ],
        },
      });

      map.on('error', (e) => console.error('MapLibre error:', e.error || e));
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

      map.on('load', () => {
        if (!map) return;
        poisData.features.forEach((feature: any) => {
          if (feature.geometry.type !== 'Point') return;
          const coords = feature.geometry.coordinates as [number, number];
          const props = feature.properties as PoiProperties;

          const label = document.createElement('div');
          label.textContent = props.name;
          Object.assign(label.style, {
            fontSize: '11px',
            fontWeight: '600',
            fontFamily: 'system-ui, sans-serif',
            color: '#1e293b',
            background: 'rgba(255, 255, 255, 0.9)',
            padding: '2px 6px',
            borderRadius: '4px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            whiteSpace: 'nowrap',
            cursor: 'pointer',
          });

          const popup = new maplibregl.Popup({ offset: 14 }).setHTML(
            `<strong>${props.name}</strong><p style="margin:4px 0 0;font-size:12px;">${props.description}</p>`
          );

          new maplibregl.Marker({ element: label, anchor: 'bottom', offset: [0, -8] })
            .setLngLat(coords)
            .setPopup(popup)
            .addTo(map!);
        });
      });
    }

    initMap();

    return () => {
      isMounted = false;
      map?.remove();
    };
  }, []);

  return (
    <div
      ref={mapContainer}
      style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh' }}
    />
  );
}