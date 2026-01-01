# Vercel Deployment Guide

## Important Notes

### ⚠️ Limitations on Vercel

1. **Socket.IO / WebSockets**: Vercel's serverless functions don't support persistent WebSocket connections. Real-time features (live chat, notifications) may not work properly. Consider:
   - Using a separate WebSocket service (e.g., Pusher, Ably, or a dedicated server)
   - Using Vercel's Edge Functions with WebSockets (if available)
   - Deploying the Socket.IO server separately on a platform that supports WebSockets (Railway, Render, etc.)

2. **File Uploads**: Vercel's serverless functions use ephemeral storage. Files uploaded to `/tmp` are deleted after function execution. For production, you should:
   - Use cloud storage services (AWS S3, Cloudinary, etc.)
   - Store file URLs in the database instead of files
   - Update the upload handler to upload directly to cloud storage

3. **Environment Variables**: Make sure to set these in Vercel's dashboard:
   - `MONGO_URI` - Your MongoDB connection string
   - Any other environment variables your app needs

## Deployment Steps

1. **Install Vercel CLI** (if not already installed):
   ```bash
   npm i -g vercel
   ```

2. **Deploy to Vercel**:
   ```bash
   vercel
   ```

3. **Set Environment Variables**:
   - Go to your Vercel project dashboard
   - Navigate to Settings > Environment Variables
   - Add `MONGO_URI` with your MongoDB connection string

4. **For Production Domain**:
   - The app will be available at `your-project.vercel.app`
   - You can add a custom domain in Vercel settings

## Recommended Production Setup

For a fully functional production deployment, consider:

1. **Separate Socket.IO Server**: Deploy the Socket.IO server on a platform that supports WebSockets:
   - Railway
   - Render
   - DigitalOcean App Platform
   - AWS EC2/Elastic Beanstalk

2. **Cloud Storage for Files**: Integrate with:
   - AWS S3
   - Cloudinary
   - Google Cloud Storage
   - Azure Blob Storage

3. **Update API URLs**: After deploying Socket.IO separately, update the `socketBase()` function in `public/script.js` to point to your WebSocket server.

## Current Configuration

- API routes are accessible at `/api/*`
- Static files are served from `/public/*`
- The server automatically detects if it's running on Vercel and adjusts behavior accordingly

