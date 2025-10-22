import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Configure multer for file uploads
const upload = multer({ 
  dest: 'uploads/',
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB
});

// Transcribe endpoint
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const audioPath = req.file.path;
    const outputPath = path.join('uploads', `${uuidv4()}.json`);

    console.log(`Transcribing: ${audioPath}`);

    // Use Whisper CLI (you must have whisper installed)
    // pip install openai-whisper
    const command = `whisper "${audioPath}" --output_format json --output_dir uploads --model tiny --fp16 False`;

    try {
      execSync(command, { stdio: 'pipe' });
      
      // Find the output JSON file
      const dir = 'uploads';
      const files = fs.readdirSync(dir);
      const jsonFile = files.find(f => f.endsWith('.json') && f.includes(path.basename(audioPath, path.extname(audioPath))));
      
      if (jsonFile) {
        const jsonPath = path.join(dir, jsonFile);
        const result = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        
        // Format transcript with timestamps
        let formattedTranscript = '';
        if (result.segments) {
          for (const segment of result.segments) {
            const timestamp = formatTimestamp(segment.start);
            formattedTranscript += `[${timestamp}] ${segment.text}\n`;
          }
        } else {
          formattedTranscript = result.text || 'No transcript';
        }

        // Cleanup
        fs.unlinkSync(audioPath);
        fs.unlinkSync(jsonPath);

        return res.json({
          success: true,
          transcript: formattedTranscript.trim(),
          text: result.text || formattedTranscript.trim(),
        });
      }
    } catch (whisperError) {
      console.error('Whisper error:', whisperError);
      return res.status(500).json({ 
        error: 'Transcription failed',
        details: (whisperError as Error).message 
      });
    }
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ 
      error: 'Server error',
      details: (error as Error).message 
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'transcription' });
});

app.listen(port, () => {
  console.log(`Transcription service running on http://localhost:${port}`);
  console.log('Make sure you have Whisper installed: pip install openai-whisper');
});

function formatTimestamp(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}