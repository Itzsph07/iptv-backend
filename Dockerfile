# Use official Node.js image
FROM node:20-slim

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the app
COPY . .

# Expose the port your app uses
EXPOSE 5000

# Start the app
CMD ["npm", "start"]