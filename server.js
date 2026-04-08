require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

// Prevenir crash por PDFs corruptos en pdf-parse
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err.message);
  if (err.stack?.includes('pdf-parse') || err.stack?.includes('pdf.worker')) {
    console.error('[UNCAUGHT] Error de pdf-parse ignorado, continuando...');
  } else {
    console.error('[UNCAUGHT] Error fatal, stack:', err.stack);
  }
});
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED]', err?.message || err);
});

// Scrapers
const { 
  scrapeMevCausas, scrapeMevMovimientos, scrapeMevMovimientosMasivo, 
  scrapeMevPdf, loginMev, cookiesToString, fetchMovimientos, parsearMovimientosHtml 
} = require('./scrapers/mev');

const {
  loginPjn, obtenerListaExpedientes, obtenerTodosLosExpedientes,
  navegarAExpediente, obtenerMovimientosExpediente, parsearMovimientosDeHtml,
  buscarExpedientes, buscarExpedientePorNumero, scrapePjnMovimientosMasivo,
  obtenerTodosLosMovimientos, fetchPjnDocumentText,
  cookiesToString: pjnCookiesToString
} = require('./scrapers/pjn');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'MEV/PJN Scraper v3.0', 
    timestamp: new Date().toISOString(),
    endpoints: {
      mev: ['/mev/causas', '/mev/movimientos', '/mev/importar-movimientos-masivo'],
      pjn: ['/pjn/expedientes', '/pjn/movimientos', '/pjn/importar-movimientos-masivo']
    }
  });
});

// ================== MEV ENDPOINTS ==================

// Obtener todas las causas del MEV
app.post('/mev/causas', async (req, res) => {
  const { usuario, password } = req.body;
  
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Usuario y password requeridos' });
  }
  
  try {
    console.log(`[MEV] Obteniendo causas para vista...`);
    const resultado = await scrapeMevCausas(usuario, password);
    console.log(`[MEV] ${resultado.total} causas obtenidas en ${resultado.elapsed_seconds}s`);
    
    res.json({ 
      success: true, 
      causas: resultado.causas,
      total: resultado.total,
      elapsed_seconds: resultado.elapsed_seconds
    });
  } catch (error) {
    console.error('[MEV] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/mev/importar-causas', async (req, res) => {
  const { usuario, password } = req.body;
  
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Usuario y password requeridos' });
  }
  
  try {
    console.log(`[MEV] Importando causas para ${usuario}...`);
    const resultado = await scrapeMevCausas(usuario, password);
    console.log(`[MEV] ${resultado.total} causas encontradas en ${resultado.elapsed_seconds}s`);
    
    res.json({ success: true, ...resultado });
  } catch (error) {
    console.error('[MEV] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/mev/importar-y-vincular', async (req, res) => {
  const { usuario, password } = req.body;
  
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Usuario y password requeridos' });
  }
  
  try {
    console.log(`[MEV] Importando y vinculando causas...`);
    const resultado = await scrapeMevCausas(usuario, password);
    
    const { data: expedientes, error: expError } = await supabase
      .from('expedientes')
      .select('id, numero_causa, caratula, mev_idc, mev_ido')
      .eq('jurisdiccion', 'Provincia');
    
    if (expError) throw new Error('Error obteniendo expedientes: ' + expError.message);
    
    const vinculados = [];
    const yaVinculados = [];
    const sinVincular = [];
    
    for (const causa of resultado.causas) {
      const expediente = expedientes.find(e => 
        e.numero_causa === causa.numero || 
        e.numero_causa === causa.numero.replace('#-', '') ||
        e.numero_causa === causa.numero.replace('-', '')
      );
      
      if (expediente) {
        if (expediente.mev_idc) {
          yaVinculados.push({ ...causa, expediente_id: expediente.id });
        } else {
          const { error: updateError } = await supabase
            .from('expedientes')
            .update({ mev_idc: causa.idc, mev_ido: causa.ido })
            .eq('id', expediente.id);
          
          if (!updateError) {
            vinculados.push({ ...causa, expediente_id: expediente.id });
          }
        }
      } else {
        sinVincular.push(causa);
      }
    }
    
    console.log(`[MEV] Vinculados: ${vinculados.length}, Ya vinculados: ${yaVinculados.length}, Sin vincular: ${sinVincular.length}`);
    
    res.json({
      success: true,
      total_causas: resultado.total,
      elapsed_seconds: resultado.elapsed_seconds,
      vinculados_ahora: vinculados.length,
      ya_vinculados: yaVinculados.length,
      sin_vincular: sinVincular.length,
      detalle: { vinculados, ya_vinculados: yaVinculados, sin_vincular: sinVincular }
    });
    
  } catch (error) {
    console.error('[MEV] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/mev/movimientos', async (req, res) => {
  const { usuario, password, idc, ido, expediente_id } = req.body;
  
  if (!usuario || !password || !idc || !ido) {
    return res.status(400).json({ error: 'Faltan parámetros requeridos' });
  }
  
  try {
    console.log(`[MEV] Scrapeando movimientos para idC=${idc}, idO=${ido}...`);
    
    const cookies = await loginMev(usuario, password);
    const cookieString = cookiesToString(cookies);
    const response = await fetchMovimientos(cookieString, idc, ido);
    const data = JSON.parse(response.d);
    const movimientos = parsearMovimientosHtml(data.tramites || '');
    
    console.log(`[MEV] ${movimientos.length} movimientos encontrados`);
    
    if (expediente_id && movimientos.length > 0) {
      const movimientosConExp = movimientos.map(m => ({
        ...m,
        expediente_id,
        fuente: 'MEV',
        mev_idc: idc,
        mev_ido: ido,
        url_proveido: m.url_proveido || ''
      }));
      
      const { error } = await supabase
        .from('movimientos_judicial')
        .upsert(movimientosConExp, { 
          onConflict: 'expediente_id,fuente,fecha,tipo,url_proveido',
          ignoreDuplicates: true 
        });
      
      if (error) console.error('[MEV] Error guardando:', error);
    }
    
    res.json({ success: true, movimientos, total: movimientos.length });
  } catch (error) {
    console.error('[MEV] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/mev/importar-movimientos-masivo', async (req, res) => {
  const { usuario, password, limit } = req.body;
  
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Usuario y password requeridos' });
  }
  
  try {
    let query = supabase
      .from('expedientes')
      .select('id, mev_idc, mev_ido, numero_causa')
      .not('mev_idc', 'is', null)
      .not('mev_ido', 'is', null)
      .neq('mev_idc', '')
      .neq('mev_ido', '');
    
    if (limit && Number.isInteger(limit) && limit > 0) {
      console.log(`[MEV] ⚠️ Modo prueba: limitado a ${limit} expedientes`);
      query = query.limit(limit);
    }
    
    const { data: expedientes, error } = await query;
    
    if (error) throw error;
    
    console.log(`\n[MEV] 📁 ${expedientes.length} expedientes vinculados encontrados\n`);
    
    if (expedientes.length === 0) {
      return res.json({ 
        success: true, 
        message: 'No hay expedientes vinculados al MEV',
        total_expedientes: 0,
        total_movimientos: 0
      });
    }
    
    const { count: movimientosAntes } = await supabase
      .from('movimientos_judicial')
      .select('*', { count: 'exact', head: true })
      .eq('fuente', 'MEV');
    
    const resultado = await scrapeMevMovimientosMasivo(usuario, password, expedientes);
    
    let intentosGuardado = 0;
    let erroresGuardado = 0;
    
    console.log(`\n[MEV] 💾 GUARDANDO EN SUPABASE...\n`);
    
    for (const r of resultado.resultados) {
      if (r.movimientos && r.movimientos.length > 0) {
        const movimientosConExp = r.movimientos.map(m => ({
          ...m,
          expediente_id: r.expediente_id,
          fuente: 'MEV',
          mev_idc: r.mev_idc,
          mev_ido: r.mev_ido,
          url_proveido: m.url_proveido || ''
        }));
        
        const { error: insertError } = await supabase
          .from('movimientos_judicial')
          .upsert(movimientosConExp, { 
            onConflict: 'expediente_id,fuente,fecha,tipo,url_proveido',
            ignoreDuplicates: true 
          });
        
        if (!insertError) {
          intentosGuardado += r.movimientos.length;
        } else {
          erroresGuardado++;
          console.error(`  ❌ Error guardando ${r.numero_causa}: ${insertError.message}`);
        }
      }
    }
    
    const { count: movimientosDespues } = await supabase
      .from('movimientos_judicial')
      .select('*', { count: 'exact', head: true })
      .eq('fuente', 'MEV');
    
    const nuevosAgregados = (movimientosDespues || 0) - (movimientosAntes || 0);
    
    res.json({
      success: true,
      expedientes_procesados: resultado.total_expedientes,
      total_movimientos: resultado.total_movimientos,
      total_movimientos_scrapeados: resultado.total_movimientos,
      movimientos_antes: movimientosAntes || 0,
      movimientos_ahora: movimientosDespues || 0,
      nuevos_agregados: nuevosAgregados,
      errores_guardado: erroresGuardado,
      elapsed_seconds: resultado.elapsed_seconds,
      resumen: {
        con_movimientos: resultado.con_movimientos,
        sin_movimientos: resultado.sin_movimientos,
        con_errores: resultado.con_errores
      }
    });
    
  } catch (error) {
    console.error('[MEV] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/mev/test-ajax', async (req, res) => {
  const { usuario, password, idc, ido } = req.body;
  
  if (!usuario || !password || !idc || !ido) {
    return res.status(400).json({ error: 'Faltan parámetros' });
  }
  
  try {
    const cookies = await loginMev(usuario, password);
    const cookieString = cookiesToString(cookies);
    const response = await fetchMovimientos(cookieString, idc, ido);
    
    const data = JSON.parse(response.d);
    const html = data.tramites || '';
    const movimientos = parsearMovimientosHtml(html);
    
    res.json({
      success: true,
      parsed_keys: Object.keys(data),
      html_length: html.length,
      movimientos_parseados: movimientos.length,
      movimientos: movimientos.slice(0, 5)
    });
    
  } catch (error) {
    console.error('[MEV] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/mev/movimientos/:expediente_id', async (req, res) => {
  const { expediente_id } = req.params;
  
  try {
    const { data, error } = await supabase
      .from('movimientos_judicial')
      .select('*')
      .eq('expediente_id', expediente_id)
      .eq('fuente', 'MEV')
      .order('fecha', { ascending: false });
    
    if (error) throw error;
    
    res.json({ success: true, movimientos: data, total: data.length });
  } catch (error) {
    console.error('[MEV] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/mev/pdf', async (req, res) => {
  const { usuario, password, url } = req.body;
  
  if (!usuario || !password || !url) {
    return res.status(400).json({ error: 'Faltan parámetros requeridos' });
  }
  
  try {
    console.log(`[MEV] Descargando PDF: ${url}`);
    
    let fullUrl = url;
    if (url.startsWith('/')) {
      fullUrl = `https://notificaciones.scba.gov.ar${url}`;
    } else if (!url.startsWith('http')) {
      fullUrl = `https://notificaciones.scba.gov.ar/${url}`;
    }
    
    const pdfData = await scrapeMevPdf(usuario, password, fullUrl);
    const isHtml = pdfData.toString().substring(0, 100).toLowerCase().includes('<html');
    
    if (isHtml) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(pdfData);
    } else {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="documento.pdf"');
      res.send(pdfData);
    }
  } catch (error) {
    console.error('[MEV] Error descargando PDF:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/expedientes/vincular-mev', async (req, res) => {
  const { expediente_id, mev_idc, mev_ido } = req.body;
  
  if (!expediente_id || !mev_idc || !mev_ido) {
    return res.status(400).json({ error: 'Faltan parámetros requeridos' });
  }
  
  try {
    const { error } = await supabase
      .from('expedientes')
      .update({ mev_idc, mev_ido })
      .eq('id', expediente_id);
    
    if (error) throw error;
    
    res.json({ success: true, message: 'Expediente vinculado correctamente' });
  } catch (error) {
    console.error('[MEV] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ================== PJN ENDPOINTS ==================

// Obtener lista de expedientes del SCW
app.post('/pjn/expedientes', async (req, res) => {
  const { usuario, password } = req.body;
  
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Usuario y password requeridos' });
  }
  
  try {
    console.log(`[PJN] Obteniendo expedientes del SCW...`);
    const startTime = Date.now();
    
    const cookies = await loginPjn(usuario, password);
    const resultado = await obtenerListaExpedientes(cookies);
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[PJN] ${resultado.expedientes.length} expedientes obtenidos en ${elapsed}s`);
    
    res.json({ 
      success: true, 
      expedientes: resultado.expedientes,
      total: resultado.total,
      en_pagina: resultado.expedientes.length,
      elapsed_seconds: elapsed
    });
  } catch (error) {
    console.error('[PJN] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Obtener TODOS los expedientes (todas las páginas)
app.post('/pjn/lista-completa', async (req, res) => {
  const { usuario, password } = req.body;
  
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Usuario y password requeridos' });
  }
  
  try {
    console.log(`[PJN] Obteniendo TODOS los expedientes del SCW...`);
    const startTime = Date.now();
    
    const cookies = await loginPjn(usuario, password);
    const resultado = await obtenerTodosLosExpedientes(cookies);
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[PJN] ${resultado.total} expedientes obtenidos en ${elapsed}s`);
    
    res.json({ 
      success: true, 
      expedientes: resultado.expedientes,
      total: resultado.total,
      total_reportado: resultado.totalReportado,
      elapsed_seconds: elapsed
    });
  } catch (error) {
    console.error('[PJN] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Obtener movimientos de un expediente específico
app.post('/pjn/movimientos', async (req, res) => {
  const { usuario, password, cid, numero_expediente, expediente_id } = req.body;
  
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Usuario y password requeridos' });
  }
  
  if (!cid && !numero_expediente) {
    return res.status(400).json({ error: 'Se requiere cid o numero_expediente' });
  }
  
  try {
    console.log(`[PJN] Obteniendo movimientos...`);
    const startTime = Date.now();
    
    const cookies = await loginPjn(usuario, password);
    
    let targetCid = cid;
    if (!targetCid && numero_expediente) {
      targetCid = await buscarExpedientePorNumero(cookies, numero_expediente);
      if (!targetCid) {
        return res.status(404).json({ error: 'Expediente no encontrado en SCW' });
      }
    }
    
    const resultado = await obtenerMovimientosExpediente(cookies, targetCid);
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[PJN] ${resultado.movimientos.length} movimientos obtenidos en ${elapsed}s`);
    
    // Guardar en Supabase si viene expediente_id
    if (expediente_id && resultado.movimientos.length > 0) {
      const movimientosConExp = resultado.movimientos.map(m => ({
        expediente_id,
        fuente: 'PJN',
        fecha: m.fecha,
        tipo: m.tipo,
        descripcion: m.descripcion,
        fojas: m.fojas,
        oficina: m.oficina,
        pjn_cid: targetCid,
        url_proveido: m.url_documento || ''
      }));
      
      const { error } = await supabase
        .from('movimientos_judicial')
        .upsert(movimientosConExp, { 
          onConflict: 'expediente_id,fuente,fecha,tipo,url_proveido',
          ignoreDuplicates: true 
        });
      
      if (error) console.error('[PJN] Error guardando:', error);
    }
    
    res.json({ 
      success: true,
      expediente: resultado.expediente,
      movimientos: resultado.movimientos,
      total: resultado.movimientos.length,
      cid: targetCid,
      elapsed_seconds: elapsed
    });
  } catch (error) {
    console.error('[PJN] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Obtener movimientos navegando por índice (sin CID previo)
app.post('/pjn/movimientos-por-indice', async (req, res) => {
  const { usuario, password, index } = req.body;
  
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Usuario y password requeridos' });
  }
  
  if (index === undefined || index === null) {
    return res.status(400).json({ error: 'Se requiere index (0-14 para primera página)' });
  }
  
  try {
    console.log(`[PJN] Obteniendo movimientos del expediente índice ${index}...`);
    const startTime = Date.now();
    
    // Login
    const cookies = await loginPjn(usuario, password);
    
    // Obtener lista con ViewState
    const lista = await obtenerListaExpedientes(cookies);
    
    if (!lista.viewState) {
      return res.status(500).json({ error: 'No se pudo obtener ViewState para navegación' });
    }
    
    if (index >= lista.expedientes.length) {
      return res.status(400).json({ 
        error: `Índice ${index} fuera de rango. Máximo: ${lista.expedientes.length - 1}` 
      });
    }
    
    // Navegar al expediente
    const nav = await navegarAExpediente(cookies, index, lista.viewState, lista.formAction, lista.pageUrl);
    
    if (!nav.cid) {
      return res.status(500).json({ error: 'No se pudo navegar al expediente' });
    }
    
    // Parsear movimientos del HTML de la navegación
    const resultado = parsearMovimientosDeHtml(nav.html, nav.cid);
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[PJN] ${resultado.movimientos.length} movimientos obtenidos en ${elapsed}s`);
    
    res.json({ 
      success: true,
      expediente_lista: lista.expedientes[index],
      expediente: resultado.expediente,
      movimientos: resultado.movimientos,
      total: resultado.movimientos.length,
      cid: nav.cid,
      elapsed_seconds: elapsed
    });
  } catch (error) {
    console.error('[PJN] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Buscar expedientes por filtros
app.post('/pjn/buscar', async (req, res) => {
  const { usuario, password, numero, anio, caratula, camara, situacion } = req.body;
  
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Usuario y password requeridos' });
  }
  
  if (!numero && !anio && !caratula && !camara && !situacion) {
    return res.status(400).json({ error: 'Se requiere al menos un filtro de búsqueda' });
  }
  
  try {
    console.log(`[PJN] Búsqueda con filtros:`, { numero, anio, caratula, camara, situacion });
    const startTime = Date.now();
    
    const cookies = await loginPjn(usuario, password);
    const resultado = await buscarExpedientes(cookies, { numero, anio, caratula, camara, situacion });
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[PJN] Búsqueda completada en ${elapsed}s`);
    
    res.json({
      success: true,
      expedientes: resultado.expedientes,
      total: resultado.total,
      elapsed_seconds: elapsed
    });
  } catch (error) {
    console.error('[PJN] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Buscar expediente específico y obtener movimientos
app.post('/pjn/buscar-movimientos', async (req, res) => {
  const { usuario, password, numero_expediente } = req.body;
  
  if (!usuario || !password || !numero_expediente) {
    return res.status(400).json({ error: 'Usuario, password y numero_expediente requeridos' });
  }
  
  try {
    console.log(`[PJN] Buscando movimientos de: ${numero_expediente}`);
    const startTime = Date.now();
    
    const cookies = await loginPjn(usuario, password);
    
    // Buscar el expediente
    const busqueda = await buscarExpedientePorNumero(cookies, numero_expediente);
    
    if (!busqueda) {
      return res.status(404).json({ 
        success: false, 
        error: `Expediente ${numero_expediente} no encontrado` 
      });
    }
    
    // Navegar al expediente para obtener movimientos
    const nav = await navegarAExpediente(
      cookies, 
      busqueda.index, 
      busqueda.viewState, 
      busqueda.formAction, 
      busqueda.pageUrl
    );
    
    // Parsear movimientos
    const resultado = parsearMovimientosDeHtml(nav.html, nav.cid);
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[PJN] ${resultado.movimientos.length} movimientos obtenidos en ${elapsed}s`);
    
    res.json({
      success: true,
      expediente_buscado: numero_expediente,
      expediente: resultado.expediente,
      movimientos: resultado.movimientos,
      total: resultado.movimientos.length,
      cid: nav.cid,
      elapsed_seconds: elapsed
    });
  } catch (error) {
    console.error('[PJN] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Importar movimientos de TODOS los expedientes CABA
app.post('/pjn/importar-movimientos-masivo', async (req, res) => {
  const { usuario, password, limit, expediente_ids } = req.body;
  
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Usuario y password requeridos' });
  }
  
  try {
    // Obtener expedientes de CABA de Supabase
    let query = supabase
      .from('expedientes')
      .select('id, numero, numero_causa, caratula')
      .eq('jurisdiccion', 'CABA')
      .range(0, 4999);
    
    // Filtrar por IDs específicos si se proporciona
    if (expediente_ids && Array.isArray(expediente_ids) && expediente_ids.length > 0) {
      console.log(`[PJN] 🎯 Modo selectivo: procesando ${expediente_ids.length} expedientes específicos`);
      query = query.in('id', expediente_ids);
    } else if (limit && Number.isInteger(limit) && limit > 0) {
      console.log(`[PJN] ⚠️ Modo prueba: limitado a ${limit} expedientes`);
      query = query.limit(limit);
    }
    
    const { data: expedientes, error } = await query;
    
    if (error) throw error;
    
    console.log(`\n[PJN] 📁 ${expedientes.length} expedientes CABA encontrados\n`);
    
    if (expedientes.length === 0) {
      return res.json({ 
        success: true, 
        message: 'No hay expedientes CABA en la base de datos',
        total_expedientes: 0,
        total_movimientos: 0
      });
    }
    
    // Obtener conteo actual
    const { count: movimientosAntes } = await supabase
      .from('movimientos_pjn')
      .select('*', { count: 'exact', head: true });
    
    console.log(`[PJN] 📊 Movimientos PJN actuales: ${movimientosAntes || 0}\n`);
    
    // Scrapear
    const resultado = await scrapePjnMovimientosMasivo(usuario, password, expedientes);
    
    // Guardar en Supabase
    let movimientosGuardados = 0;
    let erroresGuardado = 0;
    
    console.log(`\n[PJN] 💾 GUARDANDO EN SUPABASE (movimientos_pjn)...\n`);
    
    for (const r of resultado.resultados) {
      if (r.movimientos && r.movimientos.length > 0) {
        const movimientosParaGuardar = r.movimientos.map(m => ({
          expediente_id: r.expediente_id,
          fecha: m.fecha,
          tipo: m.tipo,
          descripcion: m.descripcion,
          fojas: m.fojas,
          oficina: m.oficina,
          url_documento: m.url_documento || null,
          pjn_cid: r.pjn_cid
        }));
        
        const { error: insertError } = await supabase
          .from('movimientos_pjn')
          .upsert(movimientosParaGuardar, { 
            onConflict: 'expediente_id,fecha,tipo,descripcion',
            ignoreDuplicates: true 
          });
        
        if (!insertError) {
          movimientosGuardados += r.movimientos.length;
        } else {
          erroresGuardado++;
          console.error(`  ❌ Error guardando ${r.numero_causa}: ${insertError.message}`);
        }
      }
    }
    
    // Obtener conteo después
    const { count: movimientosDespues } = await supabase
      .from('movimientos_pjn')
      .select('*', { count: 'exact', head: true });
    
    const nuevosAgregados = (movimientosDespues || 0) - (movimientosAntes || 0);
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`💾 PJN GUARDADO EN SUPABASE COMPLETADO`);
    console.log(`   📊 Movimientos antes: ${movimientosAntes || 0}`);
    console.log(`   📊 Movimientos ahora: ${movimientosDespues || 0}`);
    console.log(`   ✨ NUEVOS agregados: ${nuevosAgregados}`);
    console.log(`   ❌ Errores: ${erroresGuardado}`);
    console.log(`${'='.repeat(60)}\n`);
    
    res.json({
      success: true,
      expedientes_procesados: resultado.exitosos,
      expedientes_fallidos: resultado.fallidos,
      total_movimientos_scrapeados: resultado.totalMovimientos,
      movimientos_antes: movimientosAntes || 0,
      movimientos_ahora: movimientosDespues || 0,
      nuevos_agregados: nuevosAgregados,
      errores_guardado: erroresGuardado,
      elapsed_seconds: resultado.elapsed
    });
    
  } catch (error) {
    console.error('[PJN] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Extraer texto de documentos PJN y guardar en Supabase
app.post('/pjn/extraer-textos', async (req, res) => {
  const { usuario, password, limit } = req.body;

  if (!usuario || !password) {
    return res.status(400).json({ error: 'Usuario y password requeridos' });
  }

  try {
    // 1. Query paginado: movimientos sin texto extraído
    let pendientes = [];
    const PAGE_SIZE = 1000;
    let page = 0;

    while (true) {
      const { data, error: pageError } = await supabase
        .from('movimientos_pjn')
        .select('id, url_documento, expediente_id')
        .is('texto_documento', null)
        .not('url_documento', 'is', null)
        .neq('url_documento', '')
        .order('id', { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

      if (pageError) throw pageError;
      if (!data || data.length === 0) break;
      pendientes.push(...data);
      if (data.length < PAGE_SIZE) break;
      page++;
      if (page > 200) break;
    }

    if (limit && Number.isInteger(limit) && limit > 0) {
      pendientes = pendientes.slice(0, limit);
    }

    console.log(`\n[PJN-TEXTO] 📄 ${pendientes.length} documentos pendientes de extracción\n`);

    if (pendientes.length === 0) {
      return res.json({ success: true, message: 'No hay documentos pendientes', total: 0 });
    }

    // 2. Responder inmediatamente, procesar en background
    res.json({
      success: true,
      message: `Procesando ${pendientes.length} documentos en background`,
      total_pendientes: pendientes.length
    });

    // 3. Background: login + extracción
    (async () => {
      const startTime = Date.now();
      let cookies = await loginPjn(usuario, password);
      let cookieString = pjnCookiesToString(cookies);
      let exitos = 0, errores = 0, vacios = 0;

      const BATCH_SIZE = 5;
      for (let i = 0; i < pendientes.length; i += BATCH_SIZE) {
        // Re-login cada 200 documentos
        if (i > 0 && i % 200 === 0) {
          for (let retry = 0; retry < 5; retry++) {
            try {
              console.log(`[PJN-TEXTO] 🔄 Re-login (procesados ${i}/${pendientes.length})${retry > 0 ? ` intento ${retry + 1}` : ''}...`);
              cookies = await loginPjn(usuario, password);
              cookieString = pjnCookiesToString(cookies);
              break;
            } catch (loginErr) {
              console.error(`[PJN-TEXTO] ❌ Re-login fallido: ${loginErr.message}`);
              if (retry < 4) {
                const wait = (retry + 1) * 10000;
                console.log(`[PJN-TEXTO] ⏳ Esperando ${wait / 1000}s antes de reintentar...`);
                await new Promise(r => setTimeout(r, wait));
              } else {
                console.error(`[PJN-TEXTO] ❌ 5 intentos fallidos, abortando`);
                i = pendientes.length;
              }
            }
          }
        }

        const batch = pendientes.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(batch.map(async (mov) => {
          try {
            let texto = await fetchPjnDocumentText(cookieString, mov.url_documento);
            if (texto && texto.length > 0) {
              // Sanitizar: remover null bytes y unicode inválido que Postgres rechaza
              texto = texto.replace(/\u0000/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
              const { error: updateErr } = await supabase
                .from('movimientos_pjn')
                .update({ texto_documento: texto })
                .eq('id', mov.id);
              if (updateErr) throw new Error(`DB: ${updateErr.message}`);
              return 'ok';
            } else {
              await supabase.from('movimientos_pjn').update({ texto_documento: '' }).eq('id', mov.id);
              return 'vacio';
            }
          } catch (err) {
            console.error(`  ❌ Doc ${mov.id}: ${err.message}`);
            if (err.message.includes('404') || err.message.includes('403')) {
              await supabase.from('movimientos_pjn').update({ texto_documento: '' }).eq('id', mov.id);
            }
            throw err;
          }
        }));

        for (const r of results) {
          if (r.status === 'fulfilled' && r.value === 'ok') exitos++;
          else if (r.status === 'fulfilled' && r.value === 'vacio') vacios++;
          else errores++;
        }

        // Log de progreso cada 50
        const procesados = Math.min(i + BATCH_SIZE, pendientes.length);
        if (procesados % 50 < BATCH_SIZE) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
          console.log(`[PJN-TEXTO] 📊 ${procesados}/${pendientes.length} | ✅ ${exitos} | ❌ ${errores} | ⚪ ${vacios} | ${elapsed}s`);
        }

        // Pequeño delay entre batches
        await new Promise(r => setTimeout(r, 100));
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`\n${'='.repeat(60)}`);
      console.log(`[PJN-TEXTO] ✅ EXTRACCIÓN COMPLETADA`);
      console.log(`   📄 Total: ${pendientes.length}`);
      console.log(`   ✅ Exitosos: ${exitos}`);
      console.log(`   ❌ Errores: ${errores}`);
      console.log(`   ⚪ Vacíos: ${vacios}`);
      console.log(`   ⏱️  Tiempo: ${elapsed}s`);
      console.log(`${'='.repeat(60)}\n`);
    })().catch(err => console.error('[PJN-TEXTO] Error fatal:', err.message));

  } catch (error) {
    console.error('[PJN-TEXTO] Error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Obtener PDF/documento de PJN para mostrar en la app
app.post('/pjn/pdf', async (req, res) => {
  const { usuario, password, url } = req.body;
  
  if (!usuario || !password || !url) {
    return res.status(400).json({ error: 'Usuario, password y url requeridos' });
  }
  
  try {
    console.log(`[PJN PDF] Descargando: ${url.substring(0, 80)}...`);
    
    // Construir URL completa si es relativa
    let fullUrl = url;
    if (url.startsWith('/')) {
      fullUrl = `https://scw.pjn.gov.ar${url}`;
    } else if (!url.startsWith('http')) {
      fullUrl = `https://scw.pjn.gov.ar/${url}`;
    }
    
    // Login para obtener cookies (usa la misma función que el scraper)
    const cookies = await loginPjn(usuario, password);
    const cookieString = pjnCookiesToString(cookies);
    
    console.log(`[PJN PDF] Cookies obtenidas: ${Object.keys(cookies).length}`);
    console.log(`[PJN PDF] Accediendo a viewer: ${fullUrl}`);
    
    // Primero acceder al viewer para ver qué contiene
    const viewerRes = await fetch(fullUrl, {
      headers: {
        'Cookie': cookieString,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml,application/pdf,*/*',
        'Referer': 'https://scw.pjn.gov.ar/scw/consultaListaRelacionados.seam'
      },
      redirect: 'follow'
    });
    
    const contentType = viewerRes.headers.get('content-type') || '';
    console.log(`[PJN PDF] Content-Type: ${contentType}`);
    
    // Si es PDF directo, devolverlo
    if (contentType.includes('pdf')) {
      const pdfBuffer = Buffer.from(await viewerRes.arrayBuffer());
      console.log(`[PJN PDF] PDF directo: ${pdfBuffer.length} bytes`);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="documento.pdf"');
      return res.send(pdfBuffer);
    }
    
    // Si es HTML, buscar el PDF embebido
    const html = await viewerRes.text();
    const cheerio = require('cheerio');
    const $ = cheerio.load(html);
    
    // Buscar iframe, embed, object o link al PDF
    let pdfUrl = null;
    
    // Buscar en iframe
    const iframe = $('iframe[src*=".pdf"], iframe[src*="pdf"], iframe[src*="viewer"]').attr('src');
    if (iframe) pdfUrl = iframe;
    
    // Buscar en embed
    const embed = $('embed[src], object[data]').attr('src') || $('object[data]').attr('data');
    if (embed) pdfUrl = embed;
    
    // Buscar link de descarga
    const downloadLink = $('a[href*=".pdf"], a[href*="download"], a[onclick*="download"]').attr('href');
    if (downloadLink) pdfUrl = downloadLink;
    
    // Buscar en scripts (a veces el PDF URL está en JS)
    const scripts = $('script').text();
    const pdfMatch = scripts.match(/['"](https?:\/\/[^'"]*\.pdf[^'"]*)['"]/i) ||
                     scripts.match(/['"](\/[^'"]*\.pdf[^'"]*)['"]/i) ||
                     scripts.match(/url\s*[:=]\s*['"]([^'"]+)['"]/i);
    if (pdfMatch) pdfUrl = pdfMatch[1];
    
    console.log(`[PJN PDF] PDF URL encontrada: ${pdfUrl || 'NO ENCONTRADA'}`);
    
    if (pdfUrl) {
      // Construir URL completa si es relativa
      if (pdfUrl.startsWith('/')) {
        pdfUrl = `https://scw.pjn.gov.ar${pdfUrl}`;
      } else if (!pdfUrl.startsWith('http')) {
        pdfUrl = new URL(pdfUrl, fullUrl).href;
      }
      
      console.log(`[PJN PDF] Descargando PDF desde: ${pdfUrl}`);
      
      const pdfRes = await fetch(pdfUrl, {
        headers: {
          'Cookie': cookieString,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/pdf,*/*',
          'Referer': fullUrl
        }
      });
      
      const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());
      console.log(`[PJN PDF] PDF descargado: ${pdfBuffer.length} bytes`);
      
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="documento.pdf"');
      return res.send(pdfBuffer);
    }
    
    // Si no encontramos PDF, devolver el HTML del viewer
    console.log(`[PJN PDF] No se encontró PDF, devolviendo HTML del viewer`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
    
  } catch (error) {
    console.error('[PJN PDF] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ================== CRON: NOVEDADES DIARIAS ==================

// Endpoint optimizado para cron diario - solo obtiene novedades
app.post('/pjn/novedades-diarias', async (req, res) => {
  const { usuario, password } = req.body;
  
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Usuario y password requeridos' });
  }
  
  const startTime = Date.now();
  
  try {
    console.log('\n' + '='.repeat(60));
    console.log('🔄 PJN - ACTUALIZACIÓN DE NOVEDADES DIARIAS');
    console.log('   Fecha: ' + new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }));
    console.log('='.repeat(60) + '\n');
    
    // 1. Obtener expedientes CABA de Supabase
    const { data: expedientes, error: expError } = await supabase
      .from('expedientes')
      .select('id, numero, numero_causa, caratula')
      .eq('jurisdiccion', 'CABA');
    
    if (expError) throw expError;
    
    console.log(`[PJN] 📁 ${expedientes.length} expedientes CABA en Supabase\n`);
    
    if (expedientes.length === 0) {
      return res.json({ 
        success: true, 
        message: 'No hay expedientes CABA',
        novedades: 0
      });
    }
    
    // 2. Conteo antes
    const { count: movimientosAntes } = await supabase
      .from('movimientos_pjn')
      .select('*', { count: 'exact', head: true });
    
    console.log(`[PJN] 📊 Movimientos actuales: ${movimientosAntes || 0}\n`);
    
    // 3. Login y obtener lista del SCW
    console.log('[PJN] 🔐 Iniciando sesión en SCW...');
    const cookies = await loginPjn(usuario, password);
    
    console.log('[PJN] 📋 Obteniendo lista de expedientes del SCW...');
    const listaScw = await obtenerTodosLosExpedientes(cookies);
    console.log(`[PJN] ✓ ${listaScw.total} expedientes en SCW\n`);
    
    // 4. Matchear expedientes
    const expedientesParaProcesar = [];
    for (const exp of expedientes) {
      const numero = exp.numero || exp.numero_causa;
      if (!numero) continue;
      
      // Buscar en lista SCW
      const scwMatch = listaScw.expedientes.find(scw => {
        const scwNumero = scw.numero?.replace(/\s+/g, '') || '';
        const expNumero = numero.replace(/\s+/g, '');
        return scwNumero.includes(expNumero) || expNumero.includes(scwNumero);
      });
      
      if (scwMatch) {
        expedientesParaProcesar.push({
          ...exp,
          scw_index: listaScw.expedientes.indexOf(scwMatch),
          scw_data: scwMatch
        });
      }
    }
    
    console.log(`[PJN] 🔗 ${expedientesParaProcesar.length} expedientes matchean con SCW\n`);
    
    if (expedientesParaProcesar.length === 0) {
      return res.json({
        success: true,
        message: 'No hay expedientes para actualizar',
        novedades: 0,
        elapsed_seconds: ((Date.now() - startTime) / 1000).toFixed(1)
      });
    }
    
    // 5. Procesar en paralelo (4 workers)
    const WORKERS = 4;
    const resultados = [];
    let procesados = 0;
    let exitosos = 0;
    let fallidos = 0;
    let totalMovimientos = 0;
    
    const procesarExpediente = async (exp) => {
      try {
        const workerCookies = await loginPjn(usuario, password);
        const numero = exp.numero || exp.numero_causa;
        
        // Buscar y obtener movimientos
        const busqueda = await buscarExpedientePorNumero(workerCookies, numero);
        if (!busqueda) {
          return { success: false, exp, error: 'No encontrado en búsqueda' };
        }
        
        const nav = await navegarAExpediente(
          workerCookies,
          busqueda.index,
          busqueda.viewState,
          busqueda.formAction,
          busqueda.pageUrl
        );
        
        // Usar obtenerTodosLosMovimientos que tiene el parser que funciona bien
        const resultado = await obtenerTodosLosMovimientos(workerCookies, nav.cid, nav.html);
        
        return {
          success: true,
          exp,
          movimientos: resultado.movimientos,
          total: resultado.movimientos.length,
          pjn_cid: nav.cid
        };
      } catch (error) {
        return { success: false, exp, error: error.message };
      }
    };
    
    // Procesar en batches
    for (let i = 0; i < expedientesParaProcesar.length; i += WORKERS) {
      const batch = expedientesParaProcesar.slice(i, i + WORKERS);
      const batchResults = await Promise.all(batch.map(procesarExpediente));
      
      for (const r of batchResults) {
        procesados++;
        if (r.success) {
          exitosos++;
          totalMovimientos += r.movimientos.length;
          resultados.push(r);
          console.log(`  ✅ ${r.exp.numero || r.exp.numero_causa} - ${r.movimientos.length} movs recientes`);
        } else {
          fallidos++;
          console.log(`  ❌ ${r.exp.numero || r.exp.numero_causa} - ${r.error}`);
        }
      }
      
      // Progreso cada 20
      if (procesados % 20 === 0 || procesados === expedientesParaProcesar.length) {
        console.log(`\n[PJN] Progreso: ${procesados}/${expedientesParaProcesar.length} (${exitosos} ok, ${fallidos} fail)\n`);
      }
    }
    
    // 6. Guardar en Supabase
    console.log('\n[PJN] 💾 Guardando novedades en Supabase...\n');
    
    let guardados = 0;
    for (const r of resultados) {
      if (r.movimientos && r.movimientos.length > 0) {
        const movimientosParaGuardar = r.movimientos.map(m => ({
          expediente_id: r.exp.id,
          numero_expediente: r.exp.numero || r.exp.numero_causa,
          fecha: m.fecha,
          tipo: m.tipo,
          descripcion: m.descripcion,
          fojas: m.fojas,
          oficina: m.oficina,
          url_documento: m.url_documento || null,
          pjn_cid: r.pjn_cid
        }));
        
        const { error: insertError } = await supabase
          .from('movimientos_pjn')
          .upsert(movimientosParaGuardar, {
            onConflict: 'expediente_id,fecha,tipo,descripcion',
            ignoreDuplicates: true
          });
        
        if (!insertError) {
          guardados += r.movimientos.length;
        }
      }
    }
    
    // 7. Conteo después
    const { count: movimientosDespues } = await supabase
      .from('movimientos_pjn')
      .select('*', { count: 'exact', head: true });
    
    const novedades = (movimientosDespues || 0) - (movimientosAntes || 0);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ NOVEDADES DIARIAS COMPLETADAS');
    console.log(`   ⏱️  Tiempo: ${elapsed}s`);
    console.log(`   📁 Expedientes procesados: ${exitosos}/${expedientesParaProcesar.length}`);
    console.log(`   📊 Movimientos antes: ${movimientosAntes || 0}`);
    console.log(`   📊 Movimientos ahora: ${movimientosDespues || 0}`);
    console.log(`   ✨ NOVEDADES: ${novedades}`);
    console.log('='.repeat(60) + '\n');
    
    res.json({
      success: true,
      fecha: new Date().toISOString(),
      expedientes_procesados: exitosos,
      expedientes_fallidos: fallidos,
      movimientos_revisados: totalMovimientos,
      movimientos_antes: movimientosAntes || 0,
      movimientos_ahora: movimientosDespues || 0,
      novedades: novedades,
      elapsed_seconds: elapsed
    });
    
  } catch (error) {
    console.error('[PJN] Error novedades:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Obtener movimientos guardados de un expediente
app.get('/pjn/movimientos/:expediente_id', async (req, res) => {
  const { expediente_id } = req.params;
  
  try {
    const { data, error } = await supabase
      .from('movimientos_pjn')
      .select('*')
      .eq('expediente_id', expediente_id)
      .order('fecha', { ascending: false });
    
    if (error) throw error;
    
    res.json({ success: true, movimientos: data, total: data.length });
  } catch (error) {
    console.error('[PJN] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ================== START ==================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 MEV/PJN Scraper v3.0 running on port ${PORT}`);
});
