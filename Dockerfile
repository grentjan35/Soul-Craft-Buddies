FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Create necessary directories
RUN mkdir -p data secure_asset_chunks

# Expose port (will be overridden by PORT env var)
EXPOSE 5000

# Start the server
CMD ["npm", "start"]
