FROM node:20-alpine

# Set working directory
WORKDIR /app

# Set port for Hugging Face Spaces
ENV PORT=7860

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Create necessary directories
RUN mkdir -p data

# Expose port
EXPOSE 7860

# Start the server
CMD ["npm", "start"]
