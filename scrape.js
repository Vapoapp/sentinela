#!/usr/bin/env node
'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const PORTOS = [
  { id:'rio',     nome:'Rio de Janeiro', url:'https://silog.portosrio.gov.br/silog/pesquisa.aspx?WCI=relPrePautaSimplificado&Mv=Link&sqlCodDominio=1&sqlFLG_PUBLICO_EXTERNO=1' },
  { id:'niteroi', nome:'Niterói',        url:'https://silog.portosrio.gov.br/silog/pesquisa.aspx?WCI=relPrePautaSimplificado&Mv=Link&sqlCodDominio=2&sqlFLG_PUBLICO_EXTERNO=1' },
  { id:'itaguai', nome:'Itaguaí',        url:'https://silog.portosrio.gov.br/silog/pesquisa.aspx?WCI=relPrePautaSimplificado&Mv=Link&sqlCodDominio=3&sqlFLG_PUBLICO_EXTERNO=1' },
  { id:'angra',   nome:'Angra dos Reis', url:'https://silog.portosrio.gov.br/silog/pesquisa.aspx?WCI=relPrePautaSimplificado&Mv=Link&sqlCodDominio=4&sqlFLG_PUBLICO_EXTERNO=1' },
];

function fetchUrl(url, redirectCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
      timeout: 30000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        req.destroy();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchUrl(next, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        req.destroy();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let html = buf.toString('utf8');
        const m = html.match(/charset=["']?([a-zA-Z0-9-]+)/i);
        if (m) {
          const enc = m[1].toLowerCase().replace('-', '');
          if (['iso88591', 'latin1', 'windows1252'].includes(enc)) html = buf.toString('latin1');
        }
        resolve(html);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function stripHtml(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#\d+;/g, '')
    .trim();
}

function parseVessels(html, portoNome) {
  const vessels = [];
  const rowRe = /<tr([^>]*)>([\s\S]*?)<\/tr>/gi;
  let row;
  while ((row = rowRe.exec(html)) !== null) {
    const attrs = row[1] || '';
    const content = row[2] || '';
    if ((attrs + content).toLowerCase().includes('cancelado')) continue;
    if (content.toLowerCase().includes('colspan')) continue;
    const cells = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let td;
    while ((td = tdRe.exec(content)) !== null) cells.push(stripHtml(td[1]));
    if (cells.length >= 7) {
      const navio = cells[2];
      if (navio && navio.length > 1) {
        vessels.push({ porto: portoNome, inicio: cells[0], imo: cells[1], navio, tipo: cells[3], de: cells[4], para: cells[5], agente: cells[6] });
      }
    }
  }
  return vessels;
}

async function fetchWithRetry(url, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try { return await fetchUrl(url); } catch (e) {
      lastErr = e;
      if (i < retries - 1) {
        const delay = (i + 1) * 3000;
        console.log('  retry ' + (i + 1) + '/' + (retries - 1) + ' in ' + (delay / 1000) + 's...');
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

async function main() {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const allVessels = [];
  const portStatus = {};
  let anySuccess = false;

  for (const porto of PORTOS) {
    try {
      process.stdout.write('Fetching ' + porto.nome + '... ');
      const html = await fetchWithRetry(porto.url);
      const vessels = parseVessels(html, porto.nome);
      allVessels.push(...vessels);
      portStatus[porto.id] = { ok: true, count: vessels.length };
      console.log('OK — ' + vessels.length + ' embarcações');
      anySuccess = true;
    } catch (e) {
      console.log('ERRO — ' + e.message);
      portStatus[porto.id] = { ok: false, error: e.message };
    }
  }

  if (!anySuccess) {
    console.error('Todos os portos falharam — cache não atualizado.');
    process.exit(1);
  }

  const output = { updatedAt: new Date().toISOString(), portos: portStatus, vessels: allVessels };
  const outPath = path.join(dataDir, 'vessels.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log('\nSalvo: ' + allVessels.length + ' embarcações → ' + outPath);
}

main().catch(e => { console.error(e); process.exit(1); });
