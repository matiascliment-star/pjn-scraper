/**
 * PJN Scraper - Sistema de Consulta Web (SCW)
 * Scraping via HTTP directo (sin browser) para máxima velocidad
 * 
 * v2.1 - FIX: Distingue principal de incidente en el mapa de expedientes
 */

const cheerio = require('cheerio');

const SCW_BASE_URL = 'https://scw.pjn.gov.ar';
const LOGIN_URL = 'https://sso.pjn.gov.ar';

// Función para limpiar texto de scripts JavaScript (PrimeFaces tooltips, etc)
function limpiarTextoDeScripts(texto) {
  if (!texto) return '';
  // Eliminar bloques $(function(){...});
  let limpio = texto.replace(/\$\(function\(\)\{[^}]*\}\);?/g, '');
  // Eliminar PrimeFaces.cw(...)
  limpio = limpio.replace(/PrimeFaces\.cw\([^)]*\);?/g, '');
  // Eliminar cualquier patrón widget_expediente_...
  limpio = limpio.replace(/widget_expediente_[^,'"]+/g, '');
  // Eliminar llaves sueltas y punto y coma
  limpio = limpio.replace(/[\{\}];?/g, '');
  // Limpiar espacios múltiples
  limpio = limpio.replace(/\s+/g, ' ').trim();
  return limpio;
}

// ============ LOGIN ============

async function loginPjn(usuario, password) {
  console.log('[PJN] Iniciando login...');
  
  // Paso 1: Ir directo a consultaListaRelacionados (requiere login)
  // Usar redirect manual para capturar cookies de cada dominio
  let res = await fetch(`${SCW_BASE_URL}/scw/consultaListaRelacionados.seam`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    redirect: 'manual'
  });
  
  let cookies = extractCookies(res);
  console.log(`[PJN] Paso 1 - Status: ${res.status}, Cookies: ${Object.keys(cookies).join(', ')}`);
  
  // Seguir redirects manualmente
  let location = res.headers.get('location');
  let lastUrl = `${SCW_BASE_URL}/scw/consultaListaRelacionados.seam`;
  
  while (location || res.status === 200) {
    if (location) {
      const nextUrl = location.startsWith('http') ? location : new URL(location, lastUrl).href;
      console.log(`[PJN] Redirect a: ${nextUrl.substring(0, 80)}...`);
      
      res = await fetch(nextUrl, {
        headers: {
          'Cookie': cookiesToString(cookies),
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        redirect: 'manual'
      });
      
      cookies = { ...cookies, ...extractCookies(res) };
      lastUrl = nextUrl;
      location = res.headers.get('location');
    } else {
      // No hay más redirects, leer el HTML
      break;
    }
  }
  
  let html = await res.text();
  console.log(`[PJN] URL actual: ${lastUrl.substring(0, 80)}...`);
  console.log(`[PJN] Cookies totales: ${Object.keys(cookies).length}`);
  
  // Paso 2: Detectar si estamos en la página de login de Keycloak
  const isLoginPage = html.includes('kc-form-login') || 
                      html.includes('login-actions') || 
                      html.includes('id="username"') ||
                      lastUrl.includes('sso.pjn.gov.ar');
  
  console.log(`[PJN] Es página de login: ${isLoginPage}`);
  
  if (isLoginPage) {
    console.log('[PJN] Detectada página de login Keycloak, enviando credenciales...');
    
    const $ = cheerio.load(html);
    
    // Keycloak form tiene id="kc-form-login" o action con login-actions
    const form = $('#kc-form-login').length ? $('#kc-form-login') : $('form[action*="login-actions"]').first();
    if (form.length === 0) {
      // Fallback: buscar cualquier form con username
      const forms = $('form');
      console.log(`[PJN] Forms encontrados: ${forms.length}`);
    }
    
    let formAction = form.attr('action') || '';
    
    // Si el action es relativo, construir URL completa
    if (formAction && !formAction.startsWith('http')) {
      const baseUrl = new URL(lastUrl);
      formAction = formAction.startsWith('/') 
        ? `${baseUrl.origin}${formAction}`
        : new URL(formAction, lastUrl).href;
    }
    
    // Si no encontramos form action, usar la URL actual
    if (!formAction) {
      formAction = lastUrl;
    }
    
    console.log(`[PJN] Form action: ${formAction.substring(0, 80)}...`);
    
    // Construir el body del form
    const formData = new URLSearchParams();
    
    // Agregar campos hidden
    form.find('input[type="hidden"]').each((i, el) => {
      const name = $(el).attr('name');
      const value = $(el).attr('value') || '';
      if (name) {
        formData.append(name, value);
        console.log(`[PJN] Hidden field: ${name}=${value.substring(0, 20)}...`);
      }
    });
    
    // Agregar credenciales - Keycloak usa "username" y "password"
    formData.append('username', usuario);
    formData.append('password', password);
    
    console.log(`[PJN] Enviando login POST...`);
    
    // POST del login - manejar redirects manualmente
    res = await fetch(formAction, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookiesToString(cookies),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Origin': new URL(formAction).origin,
        'Referer': lastUrl
      },
      body: formData.toString(),
      redirect: 'manual'
    });
    
    // Combinar cookies
    cookies = { ...cookies, ...extractCookies(res) };
    console.log(`[PJN] Post-login status: ${res.status}`);
    console.log(`[PJN] Post-login cookies: ${Object.keys(cookies).join(', ')}`);
    
    // Seguir redirects después del login
    location = res.headers.get('location');
    lastUrl = formAction;
    
    while (location) {
      const nextUrl = location.startsWith('http') ? location : new URL(location, lastUrl).href;
      console.log(`[PJN] Post-login redirect a: ${nextUrl.substring(0, 80)}...`);
      
      res = await fetch(nextUrl, {
        headers: {
          'Cookie': cookiesToString(cookies),
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        redirect: 'manual'
      });
      
      cookies = { ...cookies, ...extractCookies(res) };
      lastUrl = nextUrl;
      location = res.headers.get('location');
    }
    
    html = await res.text();
    
    console.log(`[PJN] URL final: ${lastUrl}`);
  }
  
  // Verificar si el login fue exitoso
  if (html.includes('Invalid username or password') || 
      html.includes('Usuario o contraseña') || 
      html.includes('credenciales inválidas') ||
      (html.includes('kc-form-login') && !html.includes('Lista de Expedientes'))) {
    throw new Error('Login fallido - credenciales incorrectas');
  }
  
  // Verificar que llegamos al SCW
  const loggedIn = html.includes(usuario) || html.includes('Cerrar sesión') || html.includes('Lista de Expedientes');
  
  console.log(`[PJN] Login completado.`);
  console.log(`[PJN] Cookies totales: ${Object.keys(cookies).length} - ${Object.keys(cookies).join(', ')}`);
  console.log(`[PJN] Sesión activa: ${loggedIn}`);
  
  return cookies;
}

function extractCookies(response) {
  const cookies = {};
  const setCookieHeaders = response.headers.getSetCookie?.() || 
                           response.headers.get('set-cookie')?.split(', ') || [];
  
  for (const cookie of setCookieHeaders) {
    const [nameValue] = cookie.split(';');
    const [name, value] = nameValue.split('=');
    if (name && value) {
      cookies[name.trim()] = value.trim();
    }
  }
  return cookies;
}

function cookiesToString(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ============ LISTA DE EXPEDIENTES ============

async function obtenerListaExpedientes(cookies) {
  console.log('[PJN] Obteniendo lista de expedientes...');
  
  // Ir a la página de expedientes relacionados
  const res = await fetch(`${SCW_BASE_URL}/scw/consultaListaRelacionados.seam`, {
    headers: {
      'Cookie': cookiesToString(cookies),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    redirect: 'follow'
  });
  
  const html = await res.text();
  const $ = cheerio.load(html);
  
  const expedientes = [];
  
  // Debug: ver qué tablas hay
  const tablas = $('table').length;
  console.log(`[PJN] Tablas encontradas: ${tablas}`);
  console.log(`[PJN] URL respuesta: ${res.url}`);
  
  // Extraer ViewState para navegación posterior
  const viewState = $('input[name="javax.faces.ViewState"]').first().val();
  
  // Extraer el action del form para navegación
  const formAction = $('form[id*="tablaConsultaForm"]').attr('action') || '/scw/consultaListaRelacionados.seam';
  console.log(`[PJN] Form action: ${formAction}`);
  
  // Guardar la URL completa de la página para el POST
  const pageUrl = res.url;
  
  // Buscar la tabla de datos - tiene ID que contiene "dataTable"
  const tabla = $('table[id*="dataTable"]');
  console.log(`[PJN] Tabla dataTable encontrada: ${tabla.length > 0}`);
  
  // Iterar sobre las filas del tbody
  tabla.find('tbody tr').each((i, row) => {
    const $row = $(row);
    const cells = $row.find('td.column');
    
    if (cells.length >= 5) {
      const numero = $(cells[0]).text().trim();
      const dependencia = $(cells[1]).text().trim();
      const caratula = $(cells[2]).text().trim();
      const situacion = $(cells[3]).text().trim();
      const ultAct = $(cells[4]).text().trim();
      
      // Extraer el índice del expediente del onclick
      const onclick = $row.find('a[onclick*="j_idt230"]').attr('onclick') || '';
      const indexMatch = onclick.match(/dataTable:(\d+):j_idt230/);
      const index = indexMatch ? indexMatch[1] : i.toString();
      
      if (numero) {
        expedientes.push({
          numero,
          dependencia,
          caratula,
          situacion,
          ultimaActuacion: ultAct,
          index
        });
      }
    }
  });
  
  // Extraer total de la página: "Se han encontrado un total de 1.096 expediente(s)"
  const totalMatch = html.match(/total de ([\d.]+) expediente/i);
  const total = totalMatch ? parseInt(totalMatch[1].replace(/\./g, '')) : expedientes.length;
  
  console.log(`[PJN] ${expedientes.length} expedientes en página 1 (total: ${total})`);
  
  // Si no encontró expedientes, guardar HTML para debug
  if (expedientes.length === 0) {
    console.log(`[PJN] DEBUG - URL final: ${res.url}`);
    console.log(`[PJN] DEBUG - HTML contiene "Lista de Expedientes": ${html.includes('Lista de Expedientes')}`);
    console.log(`[PJN] DEBUG - HTML contiene "dataTable": ${html.includes('dataTable')}`);
    console.log(`[PJN] DEBUG - HTML contiene "sso.pjn": ${html.includes('sso.pjn')}`);
  }
  
  return { expedientes, total, html, viewState, formAction, pageUrl };
}

// Obtener siguiente página de expedientes (botón →)
async function obtenerSiguientePaginaExpedientes(cookies, viewState) {
  const nextParam = `tablaConsultaLista:tablaConsultaForm:j_idt275:j_idt292`;
  
  const body = new URLSearchParams();
  body.append('tablaConsultaLista:tablaConsultaForm', 'tablaConsultaLista:tablaConsultaForm');
  body.append('javax.faces.ViewState', viewState);
  body.append('javax.faces.source', nextParam);
  body.append('javax.faces.partial.event', 'click');
  body.append('javax.faces.partial.execute', `${nextParam} @component`);
  body.append('javax.faces.partial.render', '@component');
  body.append('org.richfaces.ajax.component', nextParam);
  body.append(nextParam, nextParam);
  body.append('rfExt', 'null');
  body.append('AJAX:EVENTS_COUNT', '1');
  body.append('javax.faces.partial.ajax', 'true');
  
  const res = await fetch(`${SCW_BASE_URL}/scw/consultaListaRelacionados.seam`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Cookie': cookiesToString(cookies),
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': '*/*',
      'Faces-Request': 'partial/ajax',
      'Origin': 'https://scw.pjn.gov.ar',
      'Referer': `${SCW_BASE_URL}/scw/consultaListaRelacionados.seam`
    },
    body: body.toString(),
    redirect: 'follow'
  });
  
  const html = await res.text();
  const expedientes = [];
  
  // Extraer el HTML del CDATA
  const cdataMatch = html.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  const tableHtml = cdataMatch ? cdataMatch[1] : html;
  
  const $ = cheerio.load(tableHtml);
  
  // Extraer nuevo ViewState
  const newViewStateMatch = html.match(/javax\.faces\.ViewState[^>]*value="([^"]+)"/);
  const newViewState = newViewStateMatch ? newViewStateMatch[1] : viewState;
  
  // Parsear filas
  $('tr').each((i, row) => {
    const $row = $(row);
    const cells = $row.find('td.column');
    
    if (cells.length >= 5) {
      const numero = $(cells[0]).text().trim();
      const dependencia = $(cells[1]).text().trim();
      const caratula = $(cells[2]).text().trim();
      const situacion = $(cells[3]).text().trim();
      const ultAct = $(cells[4]).text().trim();
      
      const onclick = $row.find('a[onclick*="j_idt230"]').attr('onclick') || '';
      const indexMatch = onclick.match(/dataTable:(\d+):j_idt230/);
      const index = indexMatch ? indexMatch[1] : i.toString();
      
      if (numero) {
        expedientes.push({
          numero,
          dependencia,
          caratula,
          situacion,
          ultimaActuacion: ultAct,
          index
        });
      }
    }
  });
  
  return { expedientes, viewState: newViewState };
}

// Obtener TODOS los expedientes (todas las páginas)
async function obtenerTodosLosExpedientes(cookies) {
  console.log('[PJN] Obteniendo TODOS los expedientes...');
  
  // Primera página
  const primera = await obtenerListaExpedientes(cookies);
  const todosExpedientes = [...primera.expedientes];
  let viewState = primera.viewState;
  
  const total = primera.total;
  const porPagina = primera.expedientes.length; // 15
  const totalPaginas = Math.ceil(total / porPagina);
  
  console.log(`[PJN] Total: ${total} expedientes en ${totalPaginas} páginas`);
  
  // Obtener resto de páginas usando botón "siguiente"
  let paginaActual = 1;
  while (todosExpedientes.length < total && paginaActual < totalPaginas) {
    paginaActual++;
    try {
      const resultado = await obtenerSiguientePaginaExpedientes(cookies, viewState);
      
      if (resultado.expedientes.length === 0) {
        console.log(`[PJN] Página ${paginaActual}: sin expedientes, terminando`);
        break;
      }
      
      todosExpedientes.push(...resultado.expedientes);
      viewState = resultado.viewState;
      
      if (paginaActual % 10 === 0) {
        console.log(`[PJN] Progreso: ${todosExpedientes.length}/${total} expedientes (página ${paginaActual})...`);
      }
      
      // Pequeña pausa cada 5 páginas
      if (paginaActual % 5 === 0) {
        await new Promise(r => setTimeout(r, 200));
      }
    } catch (error) {
      console.error(`[PJN] Error en página ${paginaActual}:`, error.message);
      break;
    }
  }
  
  console.log(`[PJN] Total obtenidos: ${todosExpedientes.length} expedientes`);
  
  return {
    expedientes: todosExpedientes,
    total: todosExpedientes.length,
    totalReportado: total
  };
}

// Obtener siguiente página de movimientos (botón →)
async function obtenerSiguientePaginaMovimientos(cookies, cid, viewState) {
  const nextParam = `expediente:j_idt217:j_idt234`;
  
  const body = new URLSearchParams();
  body.append('expediente', 'expediente');
  body.append('expediente:j_idt99:j_idt105', 'expediente:j_idt99:j_idt105');
  body.append('javax.faces.ViewState', viewState);
  body.append('expediente:j_idt99:j_idt100_collapsed', 'false');
  body.append('expediente:expedienteTab-value', 'actuaciones');
  body.append('expediente:checkBoxOtrasActuacionesId', 'on');
  body.append('javax.faces.source', nextParam);
  body.append('javax.faces.partial.event', 'click');
  body.append('javax.faces.partial.execute', `${nextParam} @component`);
  body.append('javax.faces.partial.render', '@component');
  body.append('org.richfaces.ajax.component', nextParam);
  body.append(nextParam, nextParam);
  body.append('rfExt', 'null');
  body.append('AJAX:EVENTS_COUNT', '1');
  body.append('javax.faces.partial.ajax', 'true');
  
  const res = await fetch(`${SCW_BASE_URL}/scw/expediente.seam`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Cookie': cookiesToString(cookies),
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': '*/*',
      'Faces-Request': 'partial/ajax',
      'Origin': 'https://scw.pjn.gov.ar',
      'Referer': `${SCW_BASE_URL}/scw/expediente.seam?cid=${cid}`
    },
    body: body.toString(),
    redirect: 'follow'
  });
  
  const html = await res.text();
  const movimientos = [];
  
  // Extraer el HTML del CDATA
  const cdataMatch = html.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  const tableHtml = cdataMatch ? cdataMatch[1] : html;
  
  const $ = cheerio.load(tableHtml);
  
  // Extraer nuevo ViewState
  const newViewStateMatch = html.match(/javax\.faces\.ViewState[^>]*value="([^"]+)"/);
  const newViewState = newViewStateMatch ? newViewStateMatch[1] : viewState;
  
  // Parsear movimientos
  $('tr').each((i, row) => {
    const $row = $(row);
    const cells = $row.find('td');
    
    if (cells.length >= 5) {
      // OFICINA: Solo el código corto
      let oficina = '';
      const oficinaSpan = $(cells[1]).find('span[id*="officeColumn"]');
      if (oficinaSpan.length > 0) {
        oficina = oficinaSpan.contents().filter(function() {
          return this.nodeType === 3;
        }).first().text().trim();
      }
      if (!oficina) {
        const cellText = $(cells[1]).text().trim();
        const oficinaMatch = cellText.match(/^([A-Z]{1,3}\d{0,2})/);
        if (oficinaMatch) oficina = oficinaMatch[1];
      }
      
      // FECHA (soporta span.font-color-black para juzgado Y span.font-negrita para Cámara)
      let fechaSpan = limpiarTextoDeScripts($(cells[2]).find('span.font-color-black').text().trim());
      if (!fechaSpan) {
        fechaSpan = limpiarTextoDeScripts($(cells[2]).find('span.font-negrita').text().trim());
      }
      let fecha = null;
      const fechaMatch = fechaSpan.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (fechaMatch) {
        fecha = `${fechaMatch[3]}-${fechaMatch[2].padStart(2, '0')}-${fechaMatch[1].padStart(2, '0')}`;
      }
      
      // TIPO - limpiar prefijos (soporta font-color-black y font-negrita)
      let tipo = limpiarTextoDeScripts($(cells[3]).find('span.font-color-black').text().trim());
      if (!tipo) {
        tipo = limpiarTextoDeScripts($(cells[3]).find('span.font-negrita').text().trim());
      }
      tipo = tipo.replace(/^Tipo\s*actuacion:\s*/i, '').trim();
      tipo = tipo.replace(/Descargar\s*Ver/gi, '').trim();
      
      // DESCRIPCION - limpiar prefijo de oficina (soporta font-color-black y font-negrita)
      let descripcion = limpiarTextoDeScripts($(cells[4]).find('span.font-color-black').text().trim());
      if (!descripcion) {
        descripcion = limpiarTextoDeScripts($(cells[4]).find('span.font-negrita').text().trim());
      }
      descripcion = descripcion.replace(/^Oficina:\s*[A-Z0-9]+[^;]*;?\s*/i, '').trim();
      
      // FOJAS (soporta font-color-black y font-negrita)
      let fojas = $(cells[5]) ? limpiarTextoDeScripts($(cells[5]).find('span.font-color-black').text().trim()) : '';
      if (!fojas && $(cells[5])) {
        fojas = limpiarTextoDeScripts($(cells[5]).find('span.font-negrita').text().trim());
      }
      
      const linkDoc = $row.find('a[href*="viewer.seam"]').first().attr('href');
      
      if (fechaSpan || tipo || descripcion) {
        movimientos.push({
          oficina,
          fecha,
          fechaOriginal: fechaSpan,
          tipo,
          descripcion,
          fojas,
          url_documento: linkDoc ? `${SCW_BASE_URL}${linkDoc}` : null
        });
      }
    }
  });
  
  return { movimientos, viewState: newViewState };
}

async function navegarAExpediente(cookies, index, viewState, formAction, pageUrl) {
  console.log(`[PJN] Navegando al expediente índice ${index}...`);
  
  // Construir el parámetro JSF exactamente como el browser
  const clickParam = `tablaConsultaLista:tablaConsultaForm:j_idt179:dataTable:${index}:j_idt230`;
  
  // El body del POST - exactamente como el browser
  const body = new URLSearchParams();
  body.append('tablaConsultaLista:tablaConsultaForm', 'tablaConsultaLista:tablaConsultaForm');
  body.append('javax.faces.ViewState', viewState);
  body.append(clickParam, clickParam);
  
  console.log(`[PJN] ViewState: ${viewState.substring(0, 30)}...`);
  console.log(`[PJN] Click param: ${clickParam}`);
  
  // POST con redirect manual para ver a dónde nos manda
  let res = await fetch(`${SCW_BASE_URL}/scw/consultaListaRelacionados.seam`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookiesToString(cookies),
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Origin': 'https://scw.pjn.gov.ar',
      'Referer': pageUrl || `${SCW_BASE_URL}/scw/consultaListaRelacionados.seam`
    },
    body: body.toString(),
    redirect: 'manual'  // No seguir redirect automáticamente
  });
  
  let newCookies = { ...cookies, ...extractCookies(res) };
  
  console.log(`[PJN] POST Status: ${res.status}`);
  
  // El POST devuelve 302 con Location a expediente.seam
  let location = res.headers.get('location');
  console.log(`[PJN] POST Location: ${location}`);
  
  // Seguir el redirect manualmente, convirtiendo HTTP a HTTPS
  if (location) {
    // Convertir http:// a https://
    if (location.startsWith('http://')) {
      location = location.replace('http://', 'https://');
    }
    
    console.log(`[PJN] Siguiendo redirect a: ${location}`);
    
    res = await fetch(location, {
      headers: {
        'Cookie': cookiesToString(newCookies),
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': `${SCW_BASE_URL}/scw/consultaListaRelacionados.seam`
      },
      redirect: 'follow'
    });
    
    newCookies = { ...newCookies, ...extractCookies(res) };
  }
  
  const finalUrl = res.url;
  const cidMatch = finalUrl.match(/cid=(\d+)/);
  const cid = cidMatch ? cidMatch[1] : null;
  
  console.log(`[PJN] Final URL: ${finalUrl}`);
  console.log(`[PJN] CID: ${cid}`);
  
  const html = await res.text();
  
  // Debug
  const tieneActionTable = html.includes('action-table');
  const tieneExpediente = html.includes('Datos Generales');
  console.log(`[PJN] Tiene action-table: ${tieneActionTable}, Datos Generales: ${tieneExpediente}`);

  // DEBUG: Ver qué tabs tiene la página
  const $debug = cheerio.load(html);
  const tabs = [];
  $debug('td[id*="expedienteTab"], div[id*="expedienteTab"] td, a[id*="expedienteTab"]').each((i, el) => {
    const text = $debug(el).text().trim().substring(0, 30);
    const id = $debug(el).attr('id') || '';
    if (text && !tabs.includes(text)) tabs.push(text);
  });
  // También buscar por clase de tab RichFaces
  $debug('.rf-tab-hdr-act, .rf-tab-hdr-inact, [class*="rf-tab"]').each((i, el) => {
    const text = $debug(el).text().trim().substring(0, 30);
    if (text && !tabs.includes(text)) tabs.push(text);
  });
  console.log(`[PJN] Tabs detectados: ${tabs.join(', ') || 'ninguno'}`);

  return { cid, html, cookies: newCookies, url: finalUrl };
}

// ============ ACTIVAR TAB DE ACTUACIONES ============

async function activarTabActuaciones(cookies, cid, viewState) {
  console.log(`[PJN] Activando tab de Actuaciones...`);

  // Método 1: POST con parámetros del tab RichFaces
  const body = new URLSearchParams();
  body.append('expediente', 'expediente');
  body.append('javax.faces.ViewState', viewState);
  body.append('expediente:expedienteTab-value', 'actuaciones');
  body.append('expediente:j_idt99:j_idt100_collapsed', 'false');
  body.append('expediente:checkBoxOtrasActuacionesId', 'on');
  body.append('javax.faces.source', 'expediente:expedienteTab');
  body.append('javax.faces.partial.event', 'tabchange');
  body.append('javax.faces.partial.execute', 'expediente:expedienteTab @component');
  body.append('javax.faces.partial.render', 'expediente:expedienteTab @component');
  body.append('org.richfaces.ajax.component', 'expediente:expedienteTab');
  body.append('expediente:expedienteTab:newItem', 'actuaciones');
  body.append('rfExt', 'null');
  body.append('AJAX:EVENTS_COUNT', '1');
  body.append('javax.faces.partial.ajax', 'true');

  let res = await fetch(`${SCW_BASE_URL}/scw/expediente.seam?cid=${cid}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Cookie': cookiesToString(cookies),
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': '*/*',
      'Faces-Request': 'partial/ajax',
      'Origin': 'https://scw.pjn.gov.ar',
      'Referer': `${SCW_BASE_URL}/scw/expediente.seam?cid=${cid}`
    },
    body: body.toString(),
    redirect: 'follow'
  });

  let html = await res.text();
  console.log(`[PJN] Respuesta tab AJAX: ${html.length} chars`);

  // Extraer nuevo ViewState de la respuesta AJAX
  const newViewStateMatch = html.match(/javax\.faces\.ViewState[^>]*value="([^"]+)"/);
  const newViewState = newViewStateMatch ? newViewStateMatch[1] : viewState;

  // Ahora hacer GET a la página completa con el nuevo estado
  console.log(`[PJN] Obteniendo página completa después del tab switch...`);
  res = await fetch(`${SCW_BASE_URL}/scw/expediente.seam?cid=${cid}`, {
    headers: {
      'Cookie': cookiesToString(cookies),
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': `${SCW_BASE_URL}/scw/expediente.seam?cid=${cid}`
    },
    redirect: 'follow'
  });

  html = await res.text();
  console.log(`[PJN] Página completa después de tab: ${html.length} chars, tiene action-table: ${html.includes('action-table')}`);

  return { html, viewState: newViewState };
}

// ============ MOVIMIENTOS DE UN EXPEDIENTE ============

async function obtenerMovimientosExpediente(cookies, cidOrHtml) {
  let html;
  let cid = null;
  
  // Si es un número o string corto, es un CID - hacer fetch
  if (typeof cidOrHtml === 'string' && cidOrHtml.length < 20 && /^\d+$/.test(cidOrHtml)) {
    cid = cidOrHtml;
    console.log(`[PJN] Obteniendo movimientos del expediente cid=${cid}...`);
    
    const url = `${SCW_BASE_URL}/scw/expediente.seam?cid=${cid}`;
    
    const res = await fetch(url, {
      headers: {
        'Cookie': cookiesToString(cookies),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'follow'
    });
    
    html = await res.text();
  } else {
    // Es HTML directo
    html = cidOrHtml;
    console.log(`[PJN] Parseando movimientos de HTML directo...`);
  }
  
  return parsearMovimientosDeHtml(html, cid);
}

function parsearMovimientosDeHtml(html, cid = null) {
  const $ = cheerio.load(html);
  
  // Extraer datos generales del expediente
  const expediente = {
    numero: '',
    jurisdiccion: '',
    dependencia: '',
    situacion: '',
    caratula: ''
  };
  
  // Buscar número de expediente (CNT XXXXX/YYYY o CNT XXXXX/YYYY/Z para incidentes)
  const numMatch = html.match(/CNT\s+\d+\/\d+(?:\/\d+)?/);
  if (numMatch) expediente.numero = numMatch[0];
  
  // Buscar campos por ID con selector que contiene el texto
  $('span[id*="detailCamera"]').each((i, el) => {
    expediente.jurisdiccion = $(el).text().trim();
  });
  $('span[id*="detailDependencia"]').each((i, el) => {
    expediente.dependencia = $(el).text().trim();
  });
  $('span[id*="detailSituation"]').each((i, el) => {
    expediente.situacion = $(el).text().trim();
  });
  $('span[id*="detailCover"]').each((i, el) => {
    expediente.caratula = $(el).text().trim();
  });
  
  // Extraer ViewState para paginación
  const viewState = $('input[name="javax.faces.ViewState"]').first().val();
  
  // Detectar total de páginas del paginador (buscar el número más alto)
  let totalPaginas = 1;
  $('a[class*="rf-ds-nmb"], span[class*="rf-ds-nmb"]').each((i, el) => {
    const num = parseInt($(el).text().trim());
    if (!isNaN(num) && num > totalPaginas) {
      totalPaginas = num;
    }
  });
  
  // También buscar en el onclick del paginador
  const paginadorMatch = html.match(/j_idt227:(\d+):j_idt229/g);
  if (paginadorMatch) {
    paginadorMatch.forEach(m => {
      const numMatch = m.match(/:(\d+):/);
      if (numMatch) {
        const num = parseInt(numMatch[1]) + 1; // El índice es 0-based
        if (num > totalPaginas) totalPaginas = num;
      }
    });
  }
  
  const totalActuaciones = totalPaginas * 15; // Aproximado
  
  // Parsear tabla de actuaciones
  const movimientos = [];
  
  // DEBUG: Listar TODAS las tablas del HTML
  console.log(`[PJN] DEBUG - Todas las tablas:`);
  $('table').each((i, tbl) => {
    const id = $(tbl).attr('id') || 'sin-id';
    const clase = $(tbl).attr('class') || 'sin-clase';
    const filasTbl = $(tbl).find('tbody tr').length;
    console.log(`[PJN]   Tabla ${i}: id="${id.substring(0,50)}" class="${clase.substring(0,30)}" filas=${filasTbl}`);
  });

  // Intentar varios selectores para la tabla
  let filas = $('table[id*="action-table"] tbody tr');
  if (filas.length === 0) {
    filas = $('table.rf-dt tbody tr');
  }
  if (filas.length === 0) {
    filas = $('tbody[id*="action-table"] tr');
  }
  if (filas.length === 0) {
    // Buscar cualquier tabla dentro del tab de actuaciones
    filas = $('div[id*="actuaciones"] table tbody tr, div[id*="action"] table tbody tr');
  }
  if (filas.length === 0) {
    // Buscar tabla de actuaciones por ID específico del PJN
    filas = $('table[id*="actuacion"] tbody tr, table[id*="Actuacion"] tbody tr');
  }
  if (filas.length === 0) {
    // Último intento: buscar tabla con las columnas esperadas
    filas = $('table:has(th:contains("OFICINA")) tbody tr');
  }
  
  console.log(`[PJN] Filas encontradas: ${filas.length}`);

  // DEBUG: Mostrar selectores usados
  console.log(`[PJN] DEBUG - Selector usado: table[id*="action-table"]=${$('table[id*="action-table"]').length}, table.rf-dt=${$('table.rf-dt').length}`);

  filas.each((i, row) => {
    const $row = $(row);
    const cells = $row.find('td');

    // DEBUG: Ver estructura de cada fila
    if (i < 3 || filas.length <= 5) {
      console.log(`[PJN] DEBUG Fila ${i}: ${cells.length} celdas`);
      if (cells.length > 0) {
        console.log(`[PJN] DEBUG Fila ${i} - Cell0 HTML: ${$(cells[0]).html()?.substring(0, 150)}`);
      }
    }

    if (cells.length >= 4) {
      // Buscar por IDs específicos de los spans del SCW
      
      // OFICINA: span con id que contiene "officeColumn"
      let oficina = '';
      const oficinaSpan = $row.find('span[id*="officeColumn"]');
      if (oficinaSpan.length > 0) {
        // Obtener solo el texto directo del span (ej: "T50"), no el tooltip
        const fullText = oficinaSpan.text().trim();
        const match = fullText.match(/^([A-Z]{1,3}\d{0,2})/);
        oficina = match ? match[1] : fullText.substring(0, 5);
      }
      
      // FECHA: span con id que contiene "dateColumn"
      let fecha = null;
      let fechaOriginal = '';
      const fechaSpan = $row.find('span[id*="dateColumn"]');
      const fechaText = fechaSpan.length > 0 ? fechaSpan.text().trim() : '';
      if (!fechaText) {
        // Fallback: buscar cualquier fecha en la fila
        const rowText = $row.text();
        const fechaMatch = rowText.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (fechaMatch) {
          fechaOriginal = `${fechaMatch[1]}/${fechaMatch[2]}/${fechaMatch[3]}`;
          fecha = `${fechaMatch[3]}-${fechaMatch[2].padStart(2, '0')}-${fechaMatch[1].padStart(2, '0')}`;
        }
      } else {
        const fechaMatch = fechaText.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (fechaMatch) {
          fechaOriginal = fechaText;
          fecha = `${fechaMatch[3]}-${fechaMatch[2].padStart(2, '0')}-${fechaMatch[1].padStart(2, '0')}`;
        }
      }
      
      // TIPO: span con id que contiene "typeColumn"
      let tipo = '';
      const tipoSpan = $row.find('span[id*="typeColumn"]');
      if (tipoSpan.length > 0) {
        tipo = limpiarTextoDeScripts(tipoSpan.text().trim());
      }
      // Limpiar prefijos
      tipo = tipo.replace(/^Tipo\s*actuacion:\s*/i, '').trim();
      tipo = tipo.replace(/Descargar\s*Ver/gi, '').trim();
      
      // DESCRIPCION: span con id que contiene "descriptionColumn" o "detailColumn"
      let descripcion = '';
      const descSpan = $row.find('span[id*="descriptionColumn"], span[id*="detailColumn"]');
      if (descSpan.length > 0) {
        descripcion = limpiarTextoDeScripts(descSpan.text().trim());
      }
      // Limpiar prefijo de oficina si quedó
      descripcion = descripcion.replace(/^Oficina:\s*[A-Z0-9]+[^;]*;?\s*/i, '').trim();
      
      // FOJAS: span con id que contiene "folioColumn" o "fsColumn"
      let fojas = '';
      const fojasSpan = $row.find('span[id*="folioColumn"], span[id*="fsColumn"], td:last-child span.font-color-black');
      if (fojasSpan.length > 0) {
        fojas = fojasSpan.text().trim();
        // Limpiar para dejar solo números y /
        if (fojas && !/^\d/.test(fojas)) fojas = '';
      }
      
      // URL del documento
      const linkDoc = $row.find('a[href*="viewer.seam"]').first().attr('href');
      
      // Si no encontró tipo/descripcion por ID, intentar por índice de celda
      // Soporta span.font-color-black (juzgado) Y span.font-negrita (Cámara)
      if (!tipo && !descripcion && cells.length >= 5) {
        const cell3 = $(cells[3]).find('span.font-color-black').text().trim()
                    || $(cells[3]).find('span.font-negrita').text().trim()
                    || $(cells[3]).text().trim();
        const cell4 = $(cells[4]).find('span.font-color-black').text().trim()
                    || $(cells[4]).find('span.font-negrita').text().trim()
                    || $(cells[4]).text().trim();

        tipo = limpiarTextoDeScripts(cell3).replace(/^Tipo\s*actuacion:\s*/i, '').trim();
        descripcion = limpiarTextoDeScripts(cell4).replace(/^Oficina:\s*[A-Z0-9]+[^;]*;?\s*/i, '').trim();

        if (cells.length > 5) {
          const cell5 = $(cells[5]).find('span.font-color-black').text().trim()
                      || $(cells[5]).find('span.font-negrita').text().trim()
                      || $(cells[5]).text().trim();
          if (/^\d/.test(cell5)) fojas = cell5;
        }
      }
      
      // DEBUG: Ver qué extrajo de esta fila
      if (i < 3 || (!fecha && !tipo && !descripcion)) {
        console.log(`[PJN] DEBUG Fila ${i} extraído: fecha=${fecha}, tipo=${tipo?.substring(0,30)}, desc=${descripcion?.substring(0,30)}`);
      }

      if (fecha || tipo || descripcion) {
        movimientos.push({
          oficina,
          fecha,
          fechaOriginal,
          tipo,
          descripcion,
          fojas,
          url_documento: linkDoc ? `${SCW_BASE_URL}${linkDoc}` : null
        });
      } else if (cells.length >= 4) {
        // DEBUG: Fila con celdas pero sin datos extraídos
        console.log(`[PJN] DEBUG Fila ${i} VACÍA - Raw cell1: ${$(cells[1]).text()?.substring(0,50)}, cell2: ${$(cells[2]).text()?.substring(0,50)}`);
      }
    }
  });

  // DEBUG: Mostrar info del paginador
  const paginadorLinks = $('a[class*="rf-ds"], span[class*="rf-ds"]').length;
  console.log(`[PJN] DEBUG Paginador: ${paginadorLinks} elementos encontrados`);

  console.log(`[PJN] ${movimientos.length} movimientos parseados (${totalPaginas} páginas detectadas)`);
  
  return {
    expediente,
    movimientos,
    cid,
    total: movimientos.length,
    totalPaginas,
    totalActuaciones,
    viewState
  };
}

// Obtener TODOS los movimientos de un expediente (con paginación)
async function obtenerTodosLosMovimientos(cookies, cid, htmlInicial) {
  let resultado = parsearMovimientosDeHtml(htmlInicial, cid);
  let viewState = resultado.viewState;

  // Verificar si el HTML tiene la tabla de actuaciones real (action-table)
  const $ = cheerio.load(htmlInicial);
  const tieneTablaActuaciones = $('table[id*="action-table"]').length > 0 || $('table.rf-dt').length > 0;

  // Si no tiene la tabla de actuaciones O encontró pocos movimientos, activar el tab
  if ((!tieneTablaActuaciones || resultado.movimientos.length <= 1) && viewState) {
    console.log(`[PJN] Tabla actuaciones no encontrada (tiene=${tieneTablaActuaciones}, movs=${resultado.movimientos.length}), activando tab...`);
    try {
      const tabResult = await activarTabActuaciones(cookies, cid, viewState);

      // Parsear el HTML que devolvió la función (ya incluye el GET posterior)
      resultado = parsearMovimientosDeHtml(tabResult.html, cid);
      viewState = resultado.viewState || tabResult.viewState;

      console.log(`[PJN] Después de activar tab: ${resultado.movimientos.length} movimientos`);
    } catch (err) {
      console.log(`[PJN] Error activando tab: ${err.message}`);
    }
  }

  const todosMovimientos = [...resultado.movimientos];

  // Si hay más de 1 página, paginar
  const totalPaginas = resultado.totalPaginas;
  if (totalPaginas > 1 && viewState) {
    console.log(`[PJN] Paginando movimientos: ${totalPaginas} páginas`);
    
    for (let pag = 2; pag <= totalPaginas; pag++) {
      try {
        const pagResult = await obtenerSiguientePaginaMovimientos(cookies, cid, viewState);
        todosMovimientos.push(...pagResult.movimientos);
        viewState = pagResult.viewState;
      } catch (err) {
        console.log(`[PJN] Error en página ${pag} de movimientos: ${err.message}`);
        break;
      }
    }
  }
  
  console.log(`[PJN] Total movimientos obtenidos: ${todosMovimientos.length}`);
  
  return {
    expediente: resultado.expediente,
    movimientos: todosMovimientos,
    cid,
    total: todosMovimientos.length
  };
}

function parsearMovimientosHtml(html) {
  const $ = cheerio.load(html);
  const movimientos = [];
  
  // Buscar la tabla de actuaciones
  // La tabla tiene columnas: OFICINA, FECHA, TIPO, DESCRIPCION/DETALLE, A FS.
  $('table.dataTable tbody tr, table[id*="dataTable"] tbody tr').each((i, row) => {
    const $row = $(row);
    const cells = $row.find('td');
    
    if (cells.length >= 4) {
      const oficina = limpiarTextoDeScripts($(cells[0]).text().trim());
      const fechaStr = limpiarTextoDeScripts($(cells[1]).text().trim());
      const tipo = limpiarTextoDeScripts($(cells[2]).text().trim());
      const descripcion = limpiarTextoDeScripts($(cells[3]).text().trim());
      const fojas = cells.length > 4 ? limpiarTextoDeScripts($(cells[4]).text().trim()) : '';
      
      // Convertir fecha DD/MM/YYYY a YYYY-MM-DD
      let fecha = null;
      const fechaMatch = fechaStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (fechaMatch) {
        fecha = `${fechaMatch[3]}-${fechaMatch[2].padStart(2, '0')}-${fechaMatch[1].padStart(2, '0')}`;
      }
      
      // Buscar links a documentos
      const linkPdf = $row.find('a[href*=".pdf"], a[onclick*="pdf"]').attr('href');
      const linkDoc = $row.find('a[href*="vertexto"], a[href*="verImagen"]').attr('href');
      
      if (tipo || descripcion) {
        movimientos.push({
          oficina,
          fecha,
          tipo,
          descripcion,
          fojas,
          url_documento: linkPdf || linkDoc || null
        });
      }
    }
  });
  
  // Si no encontró con la estructura anterior, intentar otra
  if (movimientos.length === 0) {
    // Buscar por estructura alternativa (PrimeFaces)
    $('[class*="actuaciones"] tr, [id*="actuaciones"] tr').each((i, row) => {
      const $row = $(row);
      const texto = $row.text();
      
      const fechaMatch = texto.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (fechaMatch) {
        const fecha = `${fechaMatch[3]}-${fechaMatch[2].padStart(2, '0')}-${fechaMatch[1].padStart(2, '0')}`;
        const cells = $row.find('td');
        
        movimientos.push({
          oficina: cells.length > 0 ? limpiarTextoDeScripts($(cells[0]).text().trim()) : '',
          fecha,
          tipo: cells.length > 2 ? limpiarTextoDeScripts($(cells[2]).text().trim()) : '',
          descripcion: cells.length > 3 ? limpiarTextoDeScripts($(cells[3]).text().trim()) : '',
          fojas: '',
          url_documento: null
        });
      }
    });
  }
  
  return movimientos;
}

// ============ BUSCAR EXPEDIENTE POR NÚMERO ============

// ============ BUSCAR EXPEDIENTES ============

async function buscarExpedientes(cookies, filtros = {}) {
  console.log(`[PJN] Buscando expedientes con filtros:`, filtros);
  
  // Primero ir a la página para obtener ViewState
  const pageRes = await fetch(`${SCW_BASE_URL}/scw/consultaListaRelacionados.seam`, {
    headers: {
      'Cookie': cookiesToString(cookies),
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    redirect: 'follow'
  });
  
  const pageHtml = await pageRes.text();
  const $ = cheerio.load(pageHtml);
  const viewState = $('input[name="javax.faces.ViewState"]').first().val();
  
  if (!viewState) {
    throw new Error('No se pudo obtener ViewState para búsqueda');
  }
  
  // Construir body de búsqueda - exactamente como el cURL del browser
  const body = new URLSearchParams();
  body.append('j_idt83:consultaExpediente', 'j_idt83:consultaExpediente');
  body.append('j_idt83:consultaExpediente:camara', filtros.camara || '');
  body.append('j_idt83:consultaExpediente:j_idt116:numero', filtros.numero || '');
  body.append('j_idt83:consultaExpediente:j_idt118:anio', filtros.anio || '');
  body.append('j_idt83:consultaExpediente:caratula', filtros.caratula || '');
  body.append('j_idt83:consultaExpediente:situation', filtros.situacion || '');
  body.append('j_idt83:consultaExpediente:consultaFiltroSearchButtonSAU', 'Consultar');
  body.append('javax.faces.ViewState', viewState);
  
  console.log(`[PJN] Enviando búsqueda...`);
  
  // POST de búsqueda
  const res = await fetch(`${SCW_BASE_URL}/scw/consultaListaRelacionados.seam`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookiesToString(cookies),
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Origin': 'https://scw.pjn.gov.ar',
      'Referer': `${SCW_BASE_URL}/scw/consultaListaRelacionados.seam`
    },
    body: body.toString(),
    redirect: 'follow'
  });
  
  const html = await res.text();
  const $result = cheerio.load(html);
  
  const expedientes = [];
  const newViewState = $result('input[name="javax.faces.ViewState"]').first().val();
  
  // Parsear resultados
  $result('table[id*="dataTable"] tbody tr').each((i, row) => {
    const $row = $result(row);
    const cells = $row.find('td.column');
    
    if (cells.length >= 5) {
      const numero = $result(cells[0]).text().trim();
      const dependencia = $result(cells[1]).text().trim();
      const caratula = $result(cells[2]).text().trim();
      const situacion = $result(cells[3]).text().trim();
      const ultAct = $result(cells[4]).text().trim();
      
      const onclick = $row.find('a[onclick*="j_idt230"]').attr('onclick') || '';
      const indexMatch = onclick.match(/dataTable:(\d+):j_idt230/);
      const index = indexMatch ? indexMatch[1] : i.toString();
      
      if (numero) {
        expedientes.push({
          numero,
          dependencia,
          caratula,
          situacion,
          ultimaActuacion: ultAct,
          index
        });
      }
    }
  });
  
  // Extraer total
  const totalMatch = html.match(/total de ([\d.]+) expediente/i);
  const total = totalMatch ? parseInt(totalMatch[1].replace(/\./g, '')) : expedientes.length;
  
  console.log(`[PJN] Búsqueda: ${expedientes.length} expedientes en página (total: ${total})`);
  
  return { 
    expedientes, 
    total, 
    viewState: newViewState,
    formAction: '/scw/consultaListaRelacionados.seam',
    pageUrl: res.url
  };
}

// Buscar expediente por número exacto
async function buscarExpedientePorNumero(cookies, numeroExpediente) {
  console.log(`[PJN] Buscando expediente: ${numeroExpediente}`);
  
  // Parsear número (ej: "CNT 019429/2025" o "CNT 019429/2025/1" para incidentes)
  const match = numeroExpediente.match(/(\d+)\/(\d+)(?:\/(\d+))?/);
  if (!match) {
    throw new Error(`Formato de expediente inválido: ${numeroExpediente}`);
  }
  
  const numero = match[1];
  const anio = match[2];
  const incidente = match[3] || null; // Capturar el número de incidente si existe
  
  // Buscar
  const resultado = await buscarExpedientes(cookies, { numero, anio });
  
  if (resultado.expedientes.length === 0) {
    return null;
  }
  
  // Buscar el expediente exacto en los resultados
  let expediente;
  
  if (incidente) {
    // Si es un incidente, buscar match exacto con el /incidente
    expediente = resultado.expedientes.find(exp =>
      exp.numero.includes(`${numero}/${anio}/${incidente}`)
    );
  } else {
    // Si es principal, buscar el que NO tenga NINGÚN sufijo después del año
    // Sufijos pueden ser: /1, /2 (números), /ES01, /ES02 (letras+números), etc.
    expediente = resultado.expedientes.find(exp => {
      const numExp = exp.numero;
      // Matchea el número base pero NO tiene nada después del año (ni /número ni /letras)
      // Regex: número/año seguido de fin de string o espacio, NO seguido de /algo
      const regexPrincipal = new RegExp(`${numero.replace(/^0+/, '')}\\/${anio}(?![/])`, 'i');
      const regexPrincipalPadded = new RegExp(`0*${numero}\\/${anio}(?![/])`, 'i');
      return (regexPrincipal.test(numExp) || regexPrincipalPadded.test(numExp)) &&
             !(/\/\d{4}\/\w+/.test(numExp)); // NO tiene /año/algo
    });
  }
  
  // Fallback: si no encontró exacto, devolver el primero que matchee
  if (!expediente) {
    console.log(`[PJN] No encontró match exacto para principal, usando fallback`);
    expediente = resultado.expedientes.find(exp =>
      exp.numero.includes(numero) && exp.numero.includes(anio)
    );
  }

  // Log para debug
  if (expediente) {
    console.log(`[PJN] Expediente seleccionado: "${expediente.numero}" (buscando: ${numeroExpediente})`);
  } else {
    console.log(`[PJN] No se encontró expediente para: ${numeroExpediente}`);
    console.log(`[PJN] Expedientes disponibles: ${resultado.expedientes.map(e => e.numero).join(', ')}`);
  }
  
  if (!expediente) {
    return null;
  }
  
  return {
    expediente,
    index: expediente.index,
    viewState: resultado.viewState,
    formAction: resultado.formAction,
    pageUrl: resultado.pageUrl
  };
}

// ============ SCRAPING MASIVO ============

async function scrapePjnMovimientosMasivo(usuario, password, expedientesSupabase) {
  const startTime = Date.now();
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📋 PJN - SCRAPING MASIVO PARALELO`);
  console.log(`   ${expedientesSupabase.length} expedientes de Supabase`);
  console.log(`${'='.repeat(60)}\n`);
  
  // Login inicial para obtener lista completa
  console.log(`[PJN] Obteniendo lista del SCW...`);
  const cookiesInicial = await loginPjn(usuario, password);
  const listaScw = await obtenerTodosLosExpedientes(cookiesInicial);
  console.log(`[PJN] ${listaScw.expedientes.length} expedientes en SCW`);
  
  // ========== FIX v2.1: CREAR MAPA CON NÚMERO COMPLETO ==========
  // Usar el número COMPLETO como clave para distinguir principal de incidente
  const mapaScw = {};
  listaScw.expedientes.forEach((exp, idx) => {
    // Capturar número completo incluyendo incidente si existe
    // Ej: "CNT 18544/2023" o "CNT 18544/2023/1"
    const numCompleto = (exp.numero || '').trim();
    
    // Extraer las partes: número base, año, e incidente opcional
    const matchCompleto = numCompleto.match(/(\d+)\/(\d{4})(?:\/(\d+))?/);
    if (matchCompleto) {
      const numBase = matchCompleto[1];
      const anio = matchCompleto[2];
      const incidente = matchCompleto[3] || null;
      
      // Clave completa (distingue principal de incidente)
      const claveCompleta = incidente 
        ? `${numBase}/${anio}/${incidente}` 
        : `${numBase}/${anio}`;
      const claveCompletaPadded = incidente
        ? `${numBase.padStart(6, '0')}/${anio}/${incidente}`
        : `${numBase.padStart(6, '0')}/${anio}`;
      
      // Guardar con clave completa
      mapaScw[claveCompleta] = { ...exp, indexGlobal: idx, esIncidente: !!incidente };
      mapaScw[claveCompletaPadded] = { ...exp, indexGlobal: idx, esIncidente: !!incidente };
      
      // También guardar bajo clave base SOLO SI ES PRINCIPAL (para fallback)
      if (!incidente) {
        const claveBase = `${numBase}/${anio}`;
        const claveBasePadded = `${numBase.padStart(6, '0')}/${anio}`;
        // Solo guardar si no existe ya (no sobrescribir)
        if (!mapaScw[`base:${claveBase}`]) {
          mapaScw[`base:${claveBase}`] = { ...exp, indexGlobal: idx, esIncidente: false };
          mapaScw[`base:${claveBasePadded}`] = { ...exp, indexGlobal: idx, esIncidente: false };
        }
      }
    }
  });
  // ========== FIN FIX v2.1 ==========
  
  // Filtrar expedientes de Supabase que están en SCW
  const expedientesAProcessar = [];
  for (const expSupa of expedientesSupabase) {
    const num = (expSupa.numero || expSupa.numero_causa || '');
    
    // Extraer número completo de Supabase
    const numMatch = num.match(/(\d+)\/(\d{4})(?:\/(\d+))?/);
    if (numMatch) {
      const numBase = numMatch[1];
      const anio = numMatch[2];
      const incidente = numMatch[3] || null;
      
      // Construir clave de búsqueda
      const claveBuscar = incidente 
        ? `${numBase}/${anio}/${incidente}`
        : `${numBase}/${anio}`;
      const claveBuscarPadded = incidente
        ? `${numBase.padStart(6, '0')}/${anio}/${incidente}`
        : `${numBase.padStart(6, '0')}/${anio}`;
      
      // Buscar match exacto primero
      let expScw = mapaScw[claveBuscar] || mapaScw[claveBuscarPadded];
      
      // Si no encontró exacto y es principal, buscar en el mapa base
      if (!expScw && !incidente) {
        expScw = mapaScw[`base:${claveBuscar}`] || mapaScw[`base:${claveBuscarPadded}`];
      }
      
      if (expScw) {
        expedientesAProcessar.push({
          supabase: expSupa,
          scw: expScw
        });
        console.log(`[PJN] Match: ${expSupa.numero} -> ${expScw.numero}`);
      } else {
        console.log(`[PJN] Sin match en SCW: ${expSupa.numero}`);
      }
    }
  }
  
  console.log(`[PJN] ${expedientesAProcessar.length} expedientes matchean entre Supabase y SCW\n`);
  
  if (expedientesAProcessar.length === 0) {
    return { resultados: [], exitosos: 0, fallidos: 0, totalMovimientos: 0, elapsed: '0' };
  }
  
  // Procesar en paralelo con N workers
  const NUM_WORKERS = 5;
  const chunks = [];
  const chunkSize = Math.ceil(expedientesAProcessar.length / NUM_WORKERS);
  
  for (let i = 0; i < expedientesAProcessar.length; i += chunkSize) {
    chunks.push(expedientesAProcessar.slice(i, i + chunkSize));
  }
  
  console.log(`[PJN] Iniciando ${chunks.length} workers en paralelo...`);
  
  // Worker function
  async function procesarChunk(chunk, workerId) {
    const resultados = [];
    
    // Login propio para este worker
    const cookies = await loginPjn(usuario, password);
    
    for (const item of chunk) {
      try {
        // Buscar el expediente usando el número EXACTO del SCW
        const busqueda = await buscarExpedientePorNumero(cookies, item.scw.numero);
        
        if (!busqueda) {
          resultados.push({
            expediente_id: item.supabase.id,
            numero_causa: item.supabase.numero,
            movimientos: [],
            total: 0,
            error: 'Búsqueda fallida'
          });
          continue;
        }
        
        // Navegar
        const nav = await navegarAExpediente(cookies, busqueda.index, busqueda.viewState, busqueda.formAction, busqueda.pageUrl);
        
        if (!nav.cid) {
          resultados.push({
            expediente_id: item.supabase.id,
            numero_causa: item.supabase.numero,
            movimientos: [],
            total: 0,
            error: 'Navegación fallida'
          });
          continue;
        }
        
        // Obtener TODOS los movimientos (con paginación)
        const resultado = await obtenerTodosLosMovimientos(cookies, nav.cid, nav.html);
        
        const movs = resultado.movimientos.map(m => ({
          fecha: m.fecha,
          tipo: m.tipo,
          descripcion: m.descripcion,
          fojas: m.fojas,
          oficina: m.oficina,
          url_documento: m.url_documento || ''
        }));
        
        console.log(`  [W${workerId}] ✅ ${item.scw.numero} -> Supabase ${item.supabase.numero} - ${movs.length} movs`);
        
        resultados.push({
          expediente_id: item.supabase.id,
          numero_causa: item.supabase.numero,
          numero_scw: item.scw.numero,
          pjn_cid: nav.cid,
          movimientos: movs,
          total: movs.length
        });
        
      } catch (err) {
        console.log(`  [W${workerId}] ❌ ${item.scw.numero} - ${err.message}`);
        resultados.push({
          expediente_id: item.supabase.id,
          numero_causa: item.supabase.numero,
          movimientos: [],
          total: 0,
          error: err.message
        });
      }
    }
    
    return resultados;
  }
  
  // Ejecutar workers en paralelo
  const promesas = chunks.map((chunk, idx) => procesarChunk(chunk, idx + 1));
  const resultadosChunks = await Promise.all(promesas);
  
  // Combinar resultados
  const resultados = resultadosChunks.flat();
  
  const exitosos = resultados.filter(r => r.total > 0).length;
  const fallidos = resultados.filter(r => r.error).length;
  const totalMovimientos = resultados.reduce((sum, r) => sum + r.total, 0);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📋 PJN - SCRAPING COMPLETADO`);
  console.log(`   ⏱️  Tiempo: ${elapsed}s`);
  console.log(`   ✅ Exitosos: ${exitosos}`);
  console.log(`   ❌ Fallidos: ${fallidos}`);
  console.log(`   📄 Total movimientos: ${totalMovimientos}`);
  console.log(`${'='.repeat(60)}\n`);
  
  return { resultados, exitosos, fallidos, totalMovimientos, elapsed };
}

// ============ EXPORTS ============

module.exports = {
  loginPjn,
  cookiesToString,
  extractCookies,
  obtenerListaExpedientes,
  obtenerSiguientePaginaExpedientes,
  obtenerTodosLosExpedientes,
  navegarAExpediente,
  obtenerMovimientosExpediente,
  obtenerSiguientePaginaMovimientos,
  obtenerTodosLosMovimientos,
  activarTabActuaciones,
  parsearMovimientosDeHtml,
  buscarExpedientes,
  buscarExpedientePorNumero,
  scrapePjnMovimientosMasivo
};
