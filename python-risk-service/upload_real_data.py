import geopandas as gpd
import numpy as np
import os
import uuid
from shapely.geometry import Polygon
from sqlalchemy import create_engine
import warnings

warnings.filterwarnings('ignore')

print("Generating synthetic offline parcels for Noida Sector 128...")
lat_center, lng_center = 28.5143, 77.3523

polygons = []
# 50 random square plots bana rahe hain
for _ in range(50):
    lat = lat_center + np.random.uniform(-0.01, 0.01)
    lng = lng_center + np.random.uniform(-0.01, 0.01)
    size = 0.0002 # Approx 20 meters ki property
    
    poly = Polygon([
        (lng, lat),
        (lng + size, lat),
        (lng + size, lat + size),
        (lng, lat + size),
        (lng, lat)
    ])
    polygons.append(poly)

gdf = gpd.GeoDataFrame(geometry=polygons, crs="EPSG:4326")

# Zaroori columns generate kar rahe hain
gdf['parcel_id'] = [str(uuid.uuid4())[:8] for _ in range(len(gdf))]
gdf['circle_rate'] = np.random.uniform(40000, 150000, size=len(gdf)).round(2)
gdf['distance_to_hazard'] = np.random.uniform(10, 1000, size=len(gdf)).round(2)
gdf['risk_score'] = 0.0

print("Connecting to Supabase...")
DB_URL = os.getenv("DATABASE_URL")
if not DB_URL:
    raise RuntimeError("DATABASE_URL must be set before uploading parcel data.")
engine = create_engine(DB_URL)

print("Uploading to PostGIS municipal_parcels table...")
gdf.to_postgis('municipal_parcels', engine, if_exists='replace', index=False)

print("Success! Data uploaded. You can now test the map.")