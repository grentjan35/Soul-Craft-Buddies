# Use Node.js 20 LTS
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Expose port (Back4App uses environment variable PORT, default to 5000)
EXPOSE 5000

# Create necessary directories
RUN mkdir -p data secure_asset_chunks

# Start the application
CMD ["npm", "start"]
