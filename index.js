import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 10000);
const PUBLIC_DIR = process.env.PUBLIC_DIR ? path.resolve(process.env.PUBLIC_DIR) : path.resolve('./rendered');
const TMP_BASE = path.join(os.tmpdir(), 'video-render');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(TMP_BASE, { recursive: true });

const app = express();
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map(s => s.trim()), credentials: true }));
app.use(express.json({ limit: '20mb' }));
app.use('/rendered', express.static(PUBLIC_DIR));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ffmpeg: 'ready', time: new Date().toISOString() });
});

app.post('/api/render', async (req, res) => {
  const { aspectRatio = '9:16', shots = [] } = req.body || {};
  if (!Array.isArray(shots) || shots.length === 0) {
    return res.status(400).json({ error: 'shots 不能为空' });
  }
  const isPortrait = aspectRatio === '9:16';
  const width = isPortrait ? 720 : 1280;
  const height = isPortrait ? 1280 : 720;
  const jobId = crypto.randomBytes(8).toString('hex');
  const jobDir = path.join(TMP_BASE, jobId);
  const framesDir = path.join(jobDir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });
  console.log(`[render] job=${jobId} start: ${shots.length} shots, ${width}x${height}`);
  const t0 = Date.now();
  try {
    const allFrameFiles = [];
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const keyframes = Array.isArray(shot.keyframes) ? shot.keyframes : [];
      const shotFiles = [];
      for (let j = 0; j < keyframes.length; j++) {
        const localPath = path.join(framesDir, `shot${i}_frame${j}.jpg`);
        await downloadFile(keyframes[j], localPath);
        shotFiles.push(localPath);
      }
      if (shotFiles.length === 0) {
        const blackPath = path.join(framesDir, `shot${i}_frame0.png`);
        await execPromise('ffmpeg', ['-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:d=1`, '-frames:v', '1', blackPath, '-y']);
        shotFiles.push(blackPath);
      }
      allFrameFiles.push(shotFiles);
    }
    const shotClips = [];
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const clipPath = path.join(jobDir, `clip_${i}.mp4`);
      await buildShotClip({ frameFiles: allFrameFiles[i], shotDuration: Number(shot.duration) || 3, transition: Number(shot.transition) || 0.2, width, height, outputPath: clipPath });
      shotClips.push(clipPath);
    }
    let videoPath;
    if (shotClips.length === 1) videoPath = shotClips[0];
    else { videoPath = path.join(jobDir, 'merged.mp4'); await concatClips(shotClips, videoPath); }
    const audioFiles = [];
    let hasAnyAudio = false;
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      if (shot.audioUrl) {
        try {
          const audioPath = path.join(jobDir, `audio_${i}.mp3`);
          await downloadFile(shot.audioUrl, audioPath);
          audioFiles.push({ path: audioPath, shotIndex: i });
          hasAnyAudio = true;
        } catch (e) { console.warn(`audio ${i} failed: ${e.message}`); }
      }
    }
    const subtitleItems = [];
    let cumTime = 0;
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const dur = Number(shot.duration) || 3;
      if (shot.subtitle && shot.subtitle.trim()) {
        subtitleItems.push({ text: shot.subtitle.trim(), startTime: cumTime + 0.1, endTime: cumTime + dur - 0.1 });
      }
      cumTime += dur;
    }
    let finalPath = videoPath;
    if (subtitleItems.length > 0) {
      const subPath = path.join(jobDir, 'with_subs.mp4');
      try { await burnSubtitles({ inputPath: videoPath, outputPath: subPath, items: subtitleItems, width, height }); finalPath = subPath; }
      catch (e) { console.warn(`subtitles failed: ${e.message}`); }
    }
    if (hasAnyAudio) {
      const mixedPath = path.join(jobDir, 'final.mp4');
      try { await mixAudio({ videoPath: finalPath, audioFiles, shotDurations: shots.map(s => Number(s.duration) || 3), outputPath: mixedPath }); finalPath = mixedPath; }
      catch (e) { console.warn(`audio mix failed: ${e.message}`); }
    }
    const duration = await probeDuration(finalPath);
    const outName = `${jobId}.mp4`;
    const outPath = path.join(PUBLIC_DIR, outName);
    fs.copyFileSync(finalPath, outPath);
    console.log(`[render] job=${jobId} done: ${duration.toFixed(2)}s, ${((Date.now()-t0)/1000).toFixed(1)}s`);
    res.json({ videoUrl: `/rendered/${outName}`, duration, jobId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[render] failed:`, msg);
    res.status(500).json({ error: msg });
  } finally {
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
  }
});

function downloadFile(url, dest) {
  return new Promise(async (resolve, reject) => {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      fs.writeFileSync(dest, Buffer.from(await resp.arrayBuffer()));
      resolve();
    } catch (e) { reject(e); }
  });
}

function execPromise(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd}: ${err.message}\n${stderr.slice(-500)}`));
      else resolve(stdout);
    });
  });
}

async function buildShotClip({ frameFiles, shotDuration, transition, width, height, outputPath }) {
  const n = frameFiles.length;
  if (n === 1) {
    await execPromise('ffmpeg', ['-loop', '1', '-i', frameFiles[0], '-t', String(shotDuration), '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=30`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'fast', '-crf', '23', '-y', outputPath]);
    return;
  }
  const staticDur = Math.max(0.3, (shotDuration - (n - 1) * transition) / n);
  const inputArgs = [];
  for (const f of frameFiles) inputArgs.push('-loop', '1', '-t', String(staticDur + transition), '-i', f);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(`[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=30,settb=AVTB,format=yuv420p[v${i}]`);
  let cur = 'v0';
  for (let i = 1; i < n; i++) {
    const offset = staticDur * i;
    const next = i === n - 1 ? 'out' : `x${i}`;
    parts.push(`[${cur}][v${i}]xfade=transition=fade:duration=${transition}:offset=${offset.toFixed(3)}[${next}]`);
    cur = next;
  }
  await execPromise('ffmpeg', [...inputArgs, '-filter_complex', parts.join(';'), '-map', '[out]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'fast', '-crf', '23', '-t', String(shotDuration), '-y', outputPath]);
}

async function concatClips(clips, outputPath) {
  const listFile = path.join(path.dirname(outputPath), 'list.txt');
  fs.writeFileSync(listFile, clips.map(p => `file '${p}'`).join('\n'));
  await execPromise('ffmpeg', ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', '-y', outputPath]);
}

async function probeDuration(p) {
  try {
    const out = await execPromise('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', p]);
    return parseFloat(out.trim()) || 0;
  } catch { return 0; }
}

async function burnSubtitles({ inputPath, outputPath, items, width, height }) {
  const fontSize = height >= 1000 ? 42 : 32;
  const marginB = Math.floor(height * 0.08);
  const filters = items.map(it => {
    const esc = it.text.replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/:/g,'\\:');
    return `drawtext=fontfile=/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc:text='${esc}':fontsize=${fontSize}:fontcolor=white:borderw=3:bordercolor=black@0.8:x=(w-text_w)/2:y=h-${marginB}-text_h:enable='between(t,${it.startTime.toFixed(3)},${it.endTime.toFixed(3)})'`;
  });
  await execPromise('ffmpeg', ['-i', inputPath, '-vf', filters.join(','), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'fast', '-crf', '23', '-c:a', 'copy', '-movflags', '+faststart', '-y', outputPath]);
}

async function mixAudio({ videoPath, audioFiles, shotDurations, outputPath }) {
  const starts = [];
  let c = 0;
  for (const d of shotDurations) { starts.push(c); c += d; }
  const args = ['-i', videoPath];
  const adelay = [];
  audioFiles.forEach((af, i) => {
    args.push('-i', af.path);
    const ms = Math.round(starts[af.shotIndex] * 1000);
    adelay.push(`[${i}:a]adelay=${ms}|${ms}[a${i}]`);
  });
  const mixIn = audioFiles.map((_, i) => `[a${i}]`).join('');
  const fc = adelay.join(';') + `;${mixIn}amix=inputs=${audioFiles.length}:duration=longest[aout]`;
  await execPromise('ffmpeg', [...args, '-filter_complex', fc, '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', '-y', outputPath]);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] running on port ${PORT}`);
});
