import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import PDFDocument from 'pdfkit';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

// Initialize Supabase FIRST
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_ANON_KEY || ''
);

const app = express();
const port = process.env.PORT || 3001;

// ============================================
// WHOP INTEGRATION - ENHANCED CORS
// ============================================
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://whop.com',
  'https://*.whop.com',
  'http://localhost:3000', // dev
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.some(allowed => {
      if (allowed.includes('*')) {
        return origin?.includes(allowed.replace('*', '')) || false;
      }
      return origin === allowed;
    })) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

app.use(express.json({ limit: '50mb' }));

// Create uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

if (!fs.existsSync('exports')) {
  fs.mkdirSync('exports');
}

// Configure multer for file uploads
const upload = multer({ 
  dest: 'uploads/',
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB
});

// ============================================
// WHOP AUTHENTICATION MIDDLEWARE
// ============================================
const authenticateUser = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // For now, allow unauthenticated requests (optional: make it required)
      // Uncomment the next line to require auth
      // return res.status(401).json({ error: 'No authorization token' });
      next(); // Allow to proceed without auth for now
      return;
    }

    const token = authHeader.replace('Bearer ', '');
    (req as any).user = { token };
    next();
  } catch (error) {
    res.status(401).json({ error: 'Unauthorized' });
  }
};

// Apply auth middleware to all API routes (optional)
app.use('/api/', authenticateUser);

// ============================================
// HEALTH CHECK
// ============================================
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'transcription',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// ============================================
// TRANSCRIPTION ENDPOINT
// ============================================
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const audioPath = req.file.path;
    const fileName = path.basename(audioPath);
    
    console.log(`📝 Transcribing: ${audioPath}`);

    // Use Whisper CLI
    const command = `whisper "${audioPath}" --output_format json --output_dir uploads --model small --fp16 False`;

    try {
      // Execute whisper command
      const output = execSync(command, { 
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      console.log('Whisper output:', output);

      // Find the generated JSON file
      const uploadsDir = 'uploads';
      const files = fs.readdirSync(uploadsDir);
      
      // Look for JSON file with matching name
      const baseFileName = path.basename(audioPath, path.extname(audioPath));
      const jsonFile = files.find(f => 
        f.includes(baseFileName) && f.endsWith('.json')
      );

      if (!jsonFile) {
        console.error('Available files:', files);
        throw new Error('Transcription output file not found');
      }

      const jsonPath = path.join(uploadsDir, jsonFile);
      console.log(`Reading JSON from: ${jsonPath}`);

      const result = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

      // Format transcript with timestamps
      let formattedTranscript = '';
      if (result.segments && Array.isArray(result.segments)) {
        for (const segment of result.segments) {
          const timestamp = formatTimestamp(segment.start);
          const text = segment.text.trim();
          if (text.length > 0) {
            formattedTranscript += `[${timestamp}] ${text}\n`;
          }
        }
      } else if (result.text) {
        formattedTranscript = result.text;
      } else {
        formattedTranscript = 'No speech detected';
      }

      // Cleanup files
      try {
        fs.unlinkSync(audioPath);
        fs.unlinkSync(jsonPath);
      } catch (e) {
        console.warn('Cleanup warning:', e);
      }

      console.log('✅ Transcription successful');

      return res.json({
        success: true,
        transcript: formattedTranscript.trim(),
        text: result.text || formattedTranscript.trim(),
      });

    } catch (whisperError) {
      console.error('❌ Whisper error:', whisperError);
      
      // Cleanup on error
      try {
        if (fs.existsSync(audioPath)) {
          fs.unlinkSync(audioPath);
        }
      } catch (e) {
        console.warn('Cleanup error:', e);
      }

      const errorMsg = (whisperError as Error).message;
      
      return res.status(500).json({ 
        error: 'Transcription failed',
        details: errorMsg,
        hint: 'Make sure Whisper is installed: pip3 install openai-whisper'
      });
    }
  } catch (error) {
    console.error('❌ Server error:', error);
    
    // Cleanup
    if (req.file && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {
        console.warn('Cleanup error:', e);
      }
    }

    return res.status(500).json({ 
      error: 'Server error',
      details: (error as Error).message 
    });
  }
});

// ============================================
// ACTION EXTRACTION ENDPOINT
// ============================================
app.post('/api/extract-actions', express.json(), async (req, res) => {
  try {
    const { transcript } = req.body;

    if (!transcript || transcript.trim().length === 0) {
      return res.status(400).json({ 
        error: 'No transcript provided',
        actions: []
      });
    }

    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) {
      return res.status(500).json({ 
        error: 'Groq API key not configured',
        actions: []
      });
    }

    console.log('Extracting actions from transcript...');

    const prompt = `You are an AI assistant that extracts action items from meeting transcripts.

Analyze the following meeting transcript and extract ALL action items. Look for:
- "I'll..." statements
- "Let's..." statements
- "We should..." statements
- "@mentions" or names followed by tasks
- Explicit commitments or tasks

For each action item, extract:
1. The action text (what needs to be done)
2. The assignee (who should do it - if not mentioned, use "Unassigned")
3. The due date (IMPORTANT: Parse time references like "tomorrow", "next 2 hours", "by end of day", "Friday" into actual dates. Use today's date as reference: ${new Date().toISOString().split('T')[0]}. If no time mentioned, use null)
4. The speaker (who said it)

Return ONLY valid JSON array with this format:
[
  {
    "action_text": "Fix the bug in login page",
    "assignee": "John",
    "due_date": "2025-10-25",
    "speaker": "Speaker 1"
  }
]

TRANSCRIPT:
${transcript}

Extract actions and parse all time references into YYYY-MM-DD format:`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.3,
        max_tokens: 1024,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Groq API error: ${JSON.stringify(error)}`);
    }

    const data = await response.json() as any;
    const content = data.choices[0].message.content;

    console.log('Raw Groq response:', content);

    // Parse JSON from response
    let actions = [];
    try {
      // Try to extract JSON from the response
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        actions = JSON.parse(jsonMatch[0]);
      } else {
        actions = JSON.parse(content);
      }
    } catch (parseError) {
      console.warn('Could not parse actions as JSON:', parseError);
      actions = [];
    }

    console.log('Extracted actions:', actions);

    return res.json({
      success: true,
      actions: actions || [],
    });

  } catch (error) {
    console.error('Action extraction error:', error);
    return res.status(500).json({ 
      error: 'Failed to extract actions',
      details: (error as Error).message,
      actions: []
    });
  }
});

// ============================================
// SUMMARY GENERATION ENDPOINT
// ============================================
app.post('/api/generate-summary', express.json(), async (req, res) => {
  try {
    const { transcript, style } = req.body;

    if (!transcript || transcript.trim().length === 0) {
      return res.status(400).json({ 
        error: 'No transcript provided'
      });
    }

    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) {
      return res.status(500).json({ 
        error: 'Groq API key not configured'
      });
    }

    const styleInstructions: { [key: string]: string } = {
      shorter: 'Create a very brief 2-3 bullet point summary.',
      longer: 'Create a detailed 7-10 bullet point summary with comprehensive details.',
      casual: 'Create a summary in a casual, conversational tone with 3-5 bullet points.',
      professional: 'Create a professional 3-5 bullet point summary.',
    };

    const instruction = styleInstructions[style as string] || styleInstructions['professional'];

    const prompt = `${instruction}

Focus on key decisions, outcomes, and next steps.

TRANSCRIPT:
${transcript}

Summary:`;

    console.log('Generating summary with style:', style);

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.3,
        max_tokens: style === 'longer' ? 800 : 500,
      }),
    });

    if (!response.ok) {
      const error = await response.json() as any;
      throw new Error(`Groq API error: ${error.error?.message || 'Unknown error'}`);
    }

    const data = await response.json() as any;
    const summary = data.choices[0].message.content;

    console.log('Summary generated successfully');

    return res.json({
      success: true,
      summary: summary,
    });

  } catch (error) {
    console.error('Summary generation error:', error);
    return res.status(500).json({ 
      error: 'Failed to generate summary',
      details: (error as Error).message,
    });
  }
});

// ============================================
// EXPORT ENDPOINTS
// ============================================

// Generate PDF export
app.post('/api/export-pdf', express.json(), async (req, res) => {
  try {
    const { title, transcript, notes, actions } = req.body;

    const doc = new PDFDocument();
    const filename = `${title.replace(/\s+/g, '_')}_${Date.now()}.pdf`;
    const filepath = path.join('exports', filename);

    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);

    // Title
    doc.fontSize(24).font('Helvetica-Bold').text(title, { align: 'center' });
    doc.fontSize(10).fillColor('gray').text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
    doc.moveDown();

    // Transcript
    if (transcript) {
      doc.fontSize(14).font('Helvetica-Bold').fillColor('black').text('Transcript');
      doc.fontSize(11).font('Helvetica').text(transcript);
      doc.moveDown();
    }

    // Notes
    if (notes) {
      doc.fontSize(14).font('Helvetica-Bold').text('Notes');
      doc.fontSize(11).font('Helvetica').text(notes);
      doc.moveDown();
    }

    // Actions
    if (actions && actions.length > 0) {
      doc.fontSize(14).font('Helvetica-Bold').text('Action Items');
      actions.forEach((action: any, index: number) => {
        doc.fontSize(11).font('Helvetica-Bold').text(`${index + 1}. ${action.action_text}`);
        doc.fontSize(10).font('Helvetica').text(`Assignee: ${action.assignee} | Due: ${action.due_date || 'Not set'}`);
        doc.moveDown(0.5);
      });
    }

    doc.end();

    stream.on('finish', () => {
      res.json({
        success: true,
        filename: filename,
        filepath: filepath,
        url: `/exports/${filename}`
      });
    });

    stream.on('error', (error) => {
      throw error;
    });
  } catch (error) {
    console.error('PDF export error:', error);
    res.status(500).json({
      error: 'Failed to generate PDF',
      details: (error as Error).message
    });
  }
});

// Generate Word export
app.post('/api/export-word', express.json(), async (req, res) => {
  try {
    const { title, transcript, notes, actions } = req.body;

    const doc = new Document({
      sections: [{
        children: [
          new Paragraph({
            text: title,
            heading: 'Heading1',
            spacing: { after: 200 }
          }),
          new Paragraph({
            text: `Generated: ${new Date().toLocaleString()}`,
            spacing: { after: 400 }
          }),
          
          // Transcript section
          ...(transcript ? [
            new Paragraph({
              text: 'Transcript',
              heading: 'Heading2',
              spacing: { after: 200 }
            }),
            new Paragraph({
              text: transcript,
              spacing: { after: 400 }
            })
          ] : []),

          // Notes section
          ...(notes ? [
            new Paragraph({
              text: 'Notes',
              heading: 'Heading2',
              spacing: { after: 200 }
            }),
            new Paragraph({
              text: notes,
              spacing: { after: 400 }
            })
          ] : []),

          // Actions section
          ...(actions && actions.length > 0 ? [
            new Paragraph({
              text: 'Action Items',
              heading: 'Heading2',
              spacing: { after: 200 }
            }),
            ...actions.flatMap((action: any, index: number) => [
              new Paragraph({
                text: `${index + 1}. ${action.action_text}`,
                spacing: { after: 100 }
              }),
              new Paragraph({
                text: `Assignee: ${action.assignee} | Due: ${action.due_date || 'Not set'}`,
                spacing: { after: 200 }
              })
            ])
          ] : [])
        ]
      }]
    });

    const filename = `${title.replace(/\s+/g, '_')}_${Date.now()}.docx`;
    const filepath = path.join('exports', filename);

    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(filepath, buffer);

    res.json({
      success: true,
      filename: filename,
      filepath: filepath,
      url: `/exports/${filename}`
    });
  } catch (error) {
    console.error('Word export error:', error);
    res.status(500).json({
      error: 'Failed to generate Word document',
      details: (error as Error).message
    });
  }
});

// Serve exported files
app.get('/exports/:filename', (req, res) => {
  const filepath = path.join('exports', req.params.filename);
  res.download(filepath);
});

// ============================================
// SHARE LINK ENDPOINTS (Supabase)
// ============================================

// Generate shareable link
app.post('/api/create-share-link', express.json(), async (req, res) => {
  try {
    const { meetingId } = req.body;

    if (!meetingId) {
      return res.status(400).json({ error: 'Meeting ID is required' });
    }

    const shareToken = uuidv4();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    console.log('Creating share link for meeting:', meetingId);

    // Store in database
    const { data, error } = await supabase
      .from('meeting_shares')
      .insert([{
        meeting_id: meetingId,
        share_token: shareToken,
        expires_at: expiresAt.toISOString(),
      }])
      .select();

    if (error) {
      console.error('Supabase insert error:', error);
      throw error;
    }

    const shareLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/share/${shareToken}`;

    console.log('Share link created:', shareLink);

    res.json({
      success: true,
      shareLink: shareLink,
      expiresAt: expiresAt.toISOString(),
      token: shareToken
    });
  } catch (error) {
    console.error('Share link error:', error);
    res.status(500).json({
      error: 'Failed to create share link',
      details: (error as Error).message
    });
  }
});

// Get shared meeting (public endpoint)
app.get('/api/share/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const { data: shareData, error: shareError } = await supabase
      .from('meeting_shares')
      .select('*, meetings(*)')
      .eq('share_token', token)
      .single();

    if (shareError || !shareData) {
      return res.status(404).json({ error: 'Share link not found' });
    }

    // Check if expired
    if (new Date(shareData.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Share link has expired' });
    }

    res.json({
      success: true,
      meeting: shareData.meetings
    });
  } catch (error) {
    console.error('Share retrieval error:', error);
    res.status(500).json({
      error: 'Failed to retrieve shared meeting',
      details: (error as Error).message
    });
  }
});

// ============================================
// WHOP MEMBERSHIP VALIDATION (OPTIONAL)
// ============================================
app.post('/api/validate-membership', express.json(), async (req, res) => {
  try {
    const { memberId } = req.body;

    if (!memberId) {
      return res.status(400).json({ error: 'memberId required' });
    }

    // TODO: Call Whop API to validate membership
    // For now, we just return true - you can add actual validation

    res.json({
      valid: true,
      memberId: memberId,
      validatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Membership validation error:', error);
    res.status(500).json({ error: 'Failed to validate membership' });
  }
});

// ============================================
// ERROR HANDLING MIDDLEWARE
// ============================================
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred'
  });
});

// ============================================
// START SERVER
// ============================================
app.listen(port, () => {
  console.log(`\n🎤 Transcription service running on http://localhost:${port}`);
  console.log(`🌐 Frontend: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);
  console.log('✅ Ready to transcribe audio files');
  console.log(`🔌 CORS enabled for Whop integration\n`);
});

// ============================================
// UTILITY FUNCTIONS
// ============================================
function formatTimestamp(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export default app;