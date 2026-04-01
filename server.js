const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const CONFIG = {
  HOSTNAME: 'api.searchad.naver.com',
  CUSTOMER_ID: '4149053',
  // [IMPORTANT] Using the latest verified API keys
  API_KEY: '0100000000e24fc0703ff414c476104aa78bb05fc85f8acab25025776ad757571c52a979ea',
  SECRET_KEY: 'AQAAAACg3ep1x3JYqHIQ+vPZOhuVIRyagkkG068rJnWvPYQsRQ==',
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function formatDt(dt) {
  if (!dt) return "2026-03-01"; 
  if (dt.includes('-')) return dt;
  return `${dt.substring(0,4)}-${dt.substring(4,6)}-${dt.substring(6,8)}`;
}

function getDatesInRange(startDate, endDate) {
  const dates = [];
  let curr = new Date(startDate);
  const end = new Date(endDate);
  while (curr <= end) {
    dates.push(curr.toISOString().split('T')[0]);
    curr.setDate(curr.getDate() + 1);
  }
  return dates;
}

function naverRequest(method, path, query = {}) {
  return new Promise((resolve, reject) => {
    const timestamp = String(Date.now());
    const searchParams = new URLSearchParams();
    
    Object.keys(query).sort().forEach(k => {
      if (query[k] !== undefined && query[k] !== '') {
        searchParams.append(k, query[k]);
      }
    });
    
    const qs = searchParams.toString() ? '?' + searchParams.toString() : '';
    const relUrl = path + qs; // 실제 전송할 전체 주소 (꼬리표 포함)
    
    // 서명을 만들 때는 꼬리표(? 이후)를 뺀 순수 경로(path)만 씁니다!
    const signature = crypto.createHmac('sha256', CONFIG.SECRET_KEY)
                            .update(`${timestamp}.${method.toUpperCase()}.${path}`)
                            .digest('base64');

    const options = {
      hostname: CONFIG.HOSTNAME,
      path: relUrl,
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Timestamp': timestamp,
        'X-API-KEY': CONFIG.API_KEY,
        'X-Customer': CONFIG.CUSTOMER_ID,
        'X-Signature': signature,
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } 
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const mapStatsToRow = (entity, stat) => {
  const spend = Number(stat.salesAmt) || 0; 
  const rev = Number(stat.convAmt) || 0;    
  const clk = Number(stat.clkCnt) || 0;
  const imp = Number(stat.impCnt) || 0;
  const cnv = Number(stat.ccnt) || 0;

  let name = entity.name || "알 수 없는 항목";
  if (entity.ad) name = entity.ad.name || (entity.ad.item && entity.ad.item.title) || name;

  return {
    id: entity.nccCampaignId || entity.nccAdgroupId || entity.nccAdId || 'unknown',
    name: name,
    spend, imp, clicks: clk, conv: cnv, revenue: rev,
    impressions: imp, conversions: cnv, cost: spend,
    ctr: imp > 0 ? Number((clk / imp * 100).toFixed(2)) : 0,
    cpc: clk > 0 ? Math.round(spend / clk) : 0,
    cvr: clk > 0 ? Number((cnv / clk * 100).toFixed(2)) : 0,
    roas: spend > 0 ? Number((rev / spend * 100).toFixed(2)) : 0,
    cpa: cnv > 0 ? Math.round(spend / cnv) : 0
  };
};

app.get('/api/daily-summary', async (req, res) => {
  try {
    const { dateFrom, dateTo, idType, targetId } = req.query;
    const safeDateFrom = formatDt(dateFrom);
    const safeDateTo = formatDt(dateTo);
    
    // 빈 달력 먼저 생성
    const dates = getDatesInRange(safeDateFrom, safeDateTo);
    const grouped = {};
    dates.forEach(d => {
       grouped[d] = { date: d, spend: 0, imp: 0, clicks: 0, conv: 0, revenue: 0 };
    });

    let targetIds = [];
    let reqIdType = idType || 'CAMPAIGN';

    if (targetId) {
        targetIds = [targetId];
    } else {
        const campRes = await naverRequest('GET', '/ncc/campaigns');
        if (campRes.status !== 200 || !Array.isArray(campRes.body)) {
            console.error("\n🚨 캠페인 목록 조회 실패:", campRes.body);
            return res.json([]); 
        }
        const campaigns = campRes.body;
        if (campaigns.length === 0) return res.json([]); 
        targetIds = campaigns.map(c => c.nccCampaignId);
    }

    // 캠페인이 많아도 한 번에 요청하도록 묶기 (최대 50개 제한)
    const targetIdsStr = targetIds.slice(0, 50).join(',');

    console.log(`\n[CHART] 일별 데이터 수집 시작 (${dates.length}일 치 긁어오기)`);

    for (const d of dates) {
      process.stdout.write(`> ${d} 데이터 수집 중... `);
      
      const statsRes = await naverRequest('GET', '/stats', {
        idType: reqIdType, 
        ids: targetIdsStr,
        fields: JSON.stringify(["impCnt", "clkCnt", "salesAmt", "ccnt", "convAmt"]), 
        timeRange: JSON.stringify({ since: d, until: d })
      });

      if (statsRes.status === 200) {
        const realData = statsRes.body.data || statsRes.body || [];
        if (Array.isArray(realData)) {
          realData.forEach(item => {
            const st = item.stat || item || {};
            grouped[d].spend += Number(st.salesAmt) || 0;
            grouped[d].imp += Number(st.impCnt) || 0;
            grouped[d].clicks += Number(st.clkCnt) || 0;
            grouped[d].conv += Number(st.ccnt) || 0;
            grouped[d].revenue += Number(st.convAmt) || 0;
          });
        }
        console.log(`OK`);
      } else {
        console.log(`FAIL (${statsRes.status})`);
      }
      await delay(150); 
    }

    const result = Object.values(grouped).map(r => {
      const ctr = r.imp > 0 ? Number((r.clicks / r.imp * 100).toFixed(2)) : 0;
      const cpc = r.clicks > 0 ? Math.round(r.spend / r.clicks) : 0;
      const cvr = r.clicks > 0 ? Number((r.conv / r.clicks * 100).toFixed(2)) : 0;
      const cpa = r.conv > 0 ? Math.round(r.spend / r.conv) : 0;
      const roas = r.spend > 0 ? Number((r.revenue / r.spend * 100).toFixed(2)) : 0;

      return {
        date_or_name: r.date, platform: 'naver', ...r,
        impressions: r.imp, conversions: r.conv, cost: r.spend,
        ctr, cpc, cvr, cpa, roas
      };
    }).sort((a,b) => a.date.localeCompare(b.date));

    console.log(`[CHART] 차트 요약 데이터 수집 완료!`);
    res.json(result);
  } catch (e) {
    console.error("❌ 차트 에러:", e.message);
    res.json([]); 
  }
});

app.get('/api/campaign-stats', async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const campRes = await naverRequest('GET', '/ncc/campaigns');
    if (campRes.status !== 200 || !Array.isArray(campRes.body)) return res.json({ rows: [] });
    const campaigns = campRes.body;
    if (campaigns.length === 0) return res.json({ rows: [] });

    const ids = campaigns.map(c => c.nccCampaignId).slice(0, 50);
    const statsRes = await naverRequest('GET', '/stats', {
      idType: 'CAMPAIGN', ids: ids.join(','), 
      fields: JSON.stringify(["impCnt", "clkCnt", "salesAmt", "ccnt", "convAmt"]), 
      timeRange: JSON.stringify({ since: formatDt(dateFrom), until: formatDt(dateTo) })
    });

    const realData = statsRes.body.data || statsRes.body || [];
    const statsMap = {};
    if (Array.isArray(realData)) realData.forEach(item => { statsMap[item.id] = item.stat || item; });

    const rows = campaigns.map(c => mapStatsToRow(c, statsMap[c.nccCampaignId] || {}));
    res.json({ rows: rows.sort((a,b)=>b.spend-a.spend) });
  } catch (e) { res.json({ rows: [] }); }
});

app.get('/api/adgroups', async (req, res) => {
  try {
    const { campaignId, dateFrom, dateTo } = req.query;
    if (!campaignId) return res.json({ rows: [] });
    const listRes = await naverRequest('GET', '/ncc/adgroups', { nccCampaignId: campaignId });
    const groups = listRes.body;
    if (!Array.isArray(groups) || !groups.length) return res.json({ rows: [] });

    const ids = groups.map(g => g.nccAdgroupId).slice(0, 50);
    const statsRes = await naverRequest('GET', '/stats', {
      idType: 'ADGROUP', ids: ids.join(','), 
      fields: JSON.stringify(["impCnt", "clkCnt", "salesAmt", "ccnt", "convAmt"]), 
      timeRange: JSON.stringify({ since: formatDt(dateFrom), until: formatDt(dateTo) })
    });

    const realData = statsRes.body.data || statsRes.body || [];
    const statsMap = {};
    if (Array.isArray(realData)) realData.forEach(item => { statsMap[item.id] = item.stat || item; });

    const rows = groups.map(g => mapStatsToRow(g, statsMap[g.nccAdgroupId] || {}));
    res.json({ rows: rows.sort((a,b)=>b.spend-a.spend) });
  } catch (e) { res.json({ rows: [] }); }
});

app.get('/api/ads', async (req, res) => {
  try {
    const { adgroupId, dateFrom, dateTo } = req.query;
    if (!adgroupId) return res.json({ rows: [] });
    const listRes = await naverRequest('GET', '/ncc/ads', { nccAdgroupId: adgroupId });
    const ads = listRes.body;
    if (!Array.isArray(ads) || !ads.length) return res.json({ rows: [] });

    const ids = ads.map(a => a.nccAdId).slice(0, 50);
    const statsRes = await naverRequest('GET', '/stats', {
      idType: 'AD', ids: ids.join(','), 
      fields: JSON.stringify(["impCnt", "clkCnt", "salesAmt", "ccnt", "convAmt"]), 
      timeRange: JSON.stringify({ since: formatDt(dateFrom), until: formatDt(dateTo) })
    });

    const realData = statsRes.body.data || statsRes.body || [];
    const statsMap = {};
    if (Array.isArray(realData)) realData.forEach(item => { statsMap[item.id] = item.stat || item; });

    const rows = ads.map(a => mapStatsToRow(a, statsMap[a.nccAdId] || {}));
    res.json({ rows: rows.sort((a,b)=>b.spend-a.spend) });
  } catch (e) { res.json({ rows: [] }); }
});

// 💥 클라우드가 지정하는 포트(process.env.PORT)를 우선적으로 사용하도록 변경!
const PORT = process.env.PORT || 3002;
const server = app.listen(PORT, () => {
  console.log(`☁️ 클라우드 웹 서버 구동 완료! (포트: ${PORT})`);
});

server.on('error', (e) => {
  console.error('\n🚨 [서버 에러]', e);
});

setInterval(() => {}, 1000 * 60 * 60);
