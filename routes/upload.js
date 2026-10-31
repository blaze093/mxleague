// ============================================
// MX League — Upload Route (Cloudinary Proxy)
// ============================================
const { v2: cloudinary } = require('cloudinary');

async function uploadRoutes(fastify) {
  // Configure Cloudinary
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });

  // POST /api/upload — Public (accept multipart, upload to Cloudinary)
  fastify.post('/', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    const data = await request.file();

    if (!data) {
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    // Validate mimetype
    const validMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
    if (!validMimeTypes.includes(data.mimetype)) {
      return reply.status(400).send({ error: 'Invalid file type. Only JPEG, PNG, and WebP are allowed.' });
    }

    try {
      // Read the file buffer
      const chunks = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      // Upload to Cloudinary
      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            upload_preset: process.env.CLOUDINARY_UPLOAD_PRESET,
            resource_type: 'image'
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        stream.end(buffer);
      });

      return {
        url: result.secure_url,
        publicId: result.public_id
      };
    } catch (err) {
      console.error('Cloudinary upload error:', err);
      return reply.status(500).send({ error: 'Upload failed' });
    }
  });
}

module.exports = uploadRoutes;
