const { chromium } = require('playwright');

const MEV_BASE_URL = 'https://notificaciones.scba.gov.ar';
const BUSCAR_ENDPOINT = '/InterfazBootstrap/vercausas.aspx/buscar';
const MOVIMIENTOS_ENDPOINT = '/InterfazBootstrap/vertramites.aspx/loadVerTramites';

async function loginMev(usuario, password) {
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    
    await page.goto(`${MEV_BASE_URL}/InterfazBootstrap/Login.aspx`, { 
      waitUntil: 'networkidle',
      timeout: 60000 
    });
    
    await page.fill('input#domicilio', usuario);
    await page.fill('input#clave', password);
    
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {}),
      page.click('button.btn-success')
    ]);
    
    await page.waitForTimeout(3000);
    const cookies = await context.cookies();
    await context.close();
    await browser.close();
    return cookies;
  } catch (error) {
    await browser.close();
    throw error;
  }
}

function cookiesToString(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

async function fetchPagina(cookieString, pagina) {
  const response = await fetch(`${MEV_BASE_URL}${BUSCAR_ENDPOINT}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cookie': cookieString,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: JSON.stringify({
      caratula: '', prefijo: '', numero: '', sufijo: '',
      departamento: '-1', org: '', descripDep: 'Todos',
      OrganismoDescrip: '', pagina: String(pagina)
    })
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}

function parsearCausasHtml(html) {
  const causas = [];
  const linkRegex = /href="\/InterfazBootstrap\/vertramites\.aspx\?idC=(\d+)&(?:amp;)?idO=(\d+)"[^>]*>([^<]+)</g;
  const numeroRegex = /Número:<\/label>\s*([#\-\d]+)/g;
  const juzgadoRegex = /Juzgado:<\/label>\s*\n?\s*([^\n<]+)/g;
  
  const numeros = [], links = [], juzgados = [];
  let match;
  while ((match = numeroRegex.exec(html)) !== null) numeros.push(match[1].trim());
  while ((match = linkRegex.exec(html)) !== null) {
    if (!links.find(l => l.idc === match[1] && l.ido === match[2])) {
      links.push({ idc: match[1], ido: match[2], caratula: match[3].trim() });
    }
  }
  while ((match = juzgadoRegex.exec(html)) !== null) juzgados.push(match[1].trim());
  
  for (let i = 0; i < links.length; i++) {
    causas.push({
      numero: numeros[i] || '',
      caratula: links[i].caratula,
      organismo: juzgados[i] || '',
      idc: links[i].idc,
      ido: links[i].ido
    });
  }
  return causas;
}

function getTotalPaginas(html) {
  const match = html.match(/id="cantPag"\s+value="(\d+)"/);
  return match ? parseInt(match[1]) : 1;
}

async function scrapeMevCausas(usuario, password) {
  const startTime = Date.now();
  const cookies = await loginMev(usuario, password);
  const cookieString = cookiesToString(cookies);
  
  const primeraPagina = await fetchPagina(cookieString, 1);
  const data = JSON.parse(primeraPagina.d);
  if (!data.result) throw new Error('Error en búsqueda');
  
  const totalPaginas = getTotalPaginas(data.causas);
  let todasLasCausas = parsearCausasHtml(data.causas);
  
  for (let batch = 2; batch <= totalPaginas; batch += 10) {
    const paginasEnBatch = [];
    for (let p = batch; p < batch + 10 && p <= totalPaginas; p++) paginasEnBatch.push(p);
    
    const promesas = paginasEnBatch.map(p => 
      fetchPagina(cookieString, p)
        .then(res => ({ pagina: p, causas: parsearCausasHtml(JSON.parse(res.d).causas) }))
        .catch(() => ({ pagina: p, causas: [] }))
    );
    
    const resultados = await Promise.all(promesas);
    for (const res of resultados) {
      for (const causa of res.causas) {
        if (!todasLasCausas.some(c => c.idc === causa.idc && c.ido === causa.ido)) {
          todasLasCausas.push(causa);
        }
      }
    }
  }
  
  return {
    causas: todasLasCausas,
    total: todasLasCausas.length,
    elapsed_seconds: ((Date.now() - startTime) / 1000).toFixed(1)
  };
}

// ============ MOVIMIENTOS ============

async function fetchMovimientos(cookieString, idc, ido) {
  const response = await fetch(`${MEV_BASE_URL}${MOVIMIENTOS_ENDPOINT}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cookie': cookieString,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: JSON.stringify({
      idCausa: String(idc), idOrg: String(ido),
      esModal: '', tramitesSelec: '', esSimp: ''
    })
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}

function parsearMovimientosHtml(html) {
  const movimientos = [];
  const parts = html.split(/<tr[^>]*>/i);
  
  for (const part of parts) {
    if (!part || part.includes('<th') || part.includes('<thead')) continue;
    
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(part)) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
    }
    
    if (cells.length >= 2) {
      const fechaMatch = part.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
      let fecha = null;
      if (fechaMatch) {
        const [dia, mes, anio] = fechaMatch[1].split('/');
        fecha = `${anio}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
      }
      
      const linkMatch = part.match(/href="([^"]*(?:VerTexto|textoNotificacion|textopresentacion|verImagen|\.pdf)[^"]*)"/i);
      const tipo = cells[0]?.substring(0, 200) || '';
      
      if (tipo && !tipo.startsWith('Número:') && !tipo.startsWith('Carátula:')) {
        movimientos.push({
          fecha,
          tipo,
          descripcion: cells[1]?.substring(0, 1000) || '',
          url_proveido: linkMatch ? linkMatch[1] : null
        });
      }
    }
  }
  return movimientos;
}

async function scrapeMevMovimientos(usuario, password, idc, ido) {
  const cookies = await loginMev(usuario, password);
  const cookieString = cookiesToString(cookies);
  const response = await fetchMovimientos(cookieString, idc, ido);
  const data = JSON.parse(response.d);
  return parsearMovimientosHtml(data.tramites || '');
}

async function scrapeMevMovimientosMasivo(usuario, password, expedientes) {
  const startTime = Date.now();
  const cookies = await loginMev(usuario, password);
  let cookieString = cookiesToString(cookies);
  
  const resultados = [];
  const totalExp = expedientes.length;
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📋 INICIANDO SCRAPING MASIVO - ${totalExp} expedientes`);
  console.log(`${'='.repeat(60)}\n`);
  
  for (let i = 0; i < expedientes.length; i += 5) {
    // Re-login cada 50 expedientes
    if (i > 0 && i % 50 === 0) {
      console.log(`\n🔄 Re-login (procesados ${i}/${totalExp})...\n`);
      const newCookies = await loginMev(usuario, password);
      cookieString = cookiesToString(newCookies);
    }
    
    const batch = expedientes.slice(i, i + 5);
    const promesas = batch.map(exp => 
      fetchMovimientos(cookieString, exp.mev_idc, exp.mev_ido)
        .then(res => {
          const data = JSON.parse(res.d);
          const movs = parsearMovimientosHtml(data.tramites || '');
          return { 
            expediente_id: exp.id, 
            numero_causa: exp.numero_causa,
            mev_idc: exp.mev_idc, 
            mev_ido: exp.mev_ido, 
            movimientos: movs, 
            total: movs.length 
          };
        })
        .catch(err => ({ 
          expediente_id: exp.id, 
          numero_causa: exp.numero_causa,
          mev_idc: exp.mev_idc, 
          mev_ido: exp.mev_ido, 
          movimientos: [], 
          total: 0, 
          error: err.message 
        }))
    );
    
    const batchResults = await Promise.all(promesas);
    resultados.push(...batchResults);
    
    // Log de progreso por cada batch
    const procesados = Math.min(i + 5, totalExp);
    const porcentaje = ((procesados / totalExp) * 100).toFixed(1);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    
    // Mostrar detalle de cada expediente del batch
    for (const r of batchResults) {
      const status = r.error ? '❌' : (r.total > 0 ? '✅' : '⚪');
      const movsText = r.error ? `ERROR: ${r.error}` : `${r.total} movs`;
      console.log(`  ${status} ${r.numero_causa || r.expediente_id} → ${movsText}`);
    }
    
    // Resumen del progreso
    const totalMovsHastaAhora = resultados.reduce((sum, r) => sum + r.total, 0);
    console.log(`📊 [${procesados}/${totalExp}] ${porcentaje}% | ${totalMovsHastaAhora} movs | ${elapsed}s\n`);
  }
  
  const totalMovs = resultados.reduce((sum, r) => sum + r.total, 0);
  const conErrores = resultados.filter(r => r.error).length;
  const conMovimientos = resultados.filter(r => r.total > 0).length;
  const sinMovimientos = resultados.filter(r => !r.error && r.total === 0).length;
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ SCRAPING COMPLETADO`);
  console.log(`   📁 Expedientes: ${totalExp}`);
  console.log(`   📝 Con movimientos: ${conMovimientos}`);
  console.log(`   ⚪ Sin movimientos: ${sinMovimientos}`);
  console.log(`   ❌ Con errores: ${conErrores}`);
  console.log(`   📊 Total movimientos: ${totalMovs}`);
  console.log(`   ⏱️  Tiempo: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  console.log(`${'='.repeat(60)}\n`);
  
  return {
    resultados,
    total_expedientes: expedientes.length,
    total_movimientos: totalMovs,
    con_movimientos: conMovimientos,
    sin_movimientos: sinMovimientos,
    con_errores: conErrores,
    elapsed_seconds: ((Date.now() - startTime) / 1000).toFixed(1)
  };
}

async function scrapeMevPdf(usuario, password, pdfUrl) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    
    // Login
    await page.goto(`${MEV_BASE_URL}/InterfazBootstrap/Login.aspx`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.fill('input#domicilio', usuario);
    await page.fill('input#clave', password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {}),
      page.click('button.btn-success')
    ]);
    await page.waitForTimeout(2000);
    
    // Construir URL completa si es relativa
    let fullUrl = pdfUrl;
    if (pdfUrl.startsWith('/')) {
      fullUrl = `${MEV_BASE_URL}${pdfUrl}`;
    }
    
    console.log(`[MEV] Navegando a: ${fullUrl}`);
    
    const response = await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 30000 });
    const buffer = await response.body();
    
    await browser.close();
    return buffer;
  } catch (error) {
    await browser.close();
    console.error('[MEV] Error en scrapeMevPdf:', error.message);
    throw error;
  }
}

module.exports = { 
  scrapeMevCausas, scrapeMevMovimientos, scrapeMevMovimientosMasivo, scrapeMevPdf,
  loginMev, cookiesToString, fetchMovimientos, parsearMovimientosHtml
};
