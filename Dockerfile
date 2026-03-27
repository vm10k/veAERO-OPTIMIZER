FROM node:20-slim

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application entry point and static assets required by the server
COPY server.js dashboard.html aero.png background-sprite.png ./

# Create any required application directories (e.g., for screenshots)
RUN mkdir -p /app/screenshots
# Expose the port the app runs on
EXPOSE 3000

# Command to run the application
CMD ["node", "server.js"]
