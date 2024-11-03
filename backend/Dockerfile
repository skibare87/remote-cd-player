# backend/Dockerfile
FROM python:3.9

# Install system dependencies (now only cdparanoia and its requirements)
RUN apt-get update && apt-get install -y \
    cdparanoia \
    libdiscid0 \
    libdiscid-dev \
    pkg-config \
    gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3000"]
