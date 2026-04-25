import YahooFinance from 'yahoo-finance2';
import { RSI, MACD } from 'technicalindicators';

const yahooFinance = new YahooFinance();

export const revalidate = 0; 

// 通用数据获取与指标计算函数
async function getTickerData(ticker: string, period1Str: string, includeMonthly = false) {
  try {
    const dailyData = await yahooFinance.historical(ticker, {
      period1: period1Str,
      period2: new Date(),
      interval: '1d',
    });
    
    if (!dailyData || dailyData.length === 0) throw new Error("No data returned");

    const closesDaily = dailyData.map((d) => d.close);
    const rsiInput = { values: closesDaily, period: 14 };
    const rsiResult = RSI.calculate(rsiInput);
    const currentRSI = rsiResult.length > 0 ? rsiResult[rsiResult.length - 1] : 50;
    const currentPrice = closesDaily[closesDaily.length - 1] || 0;

    let isMacdDeadCross = false;

    if (includeMonthly) {
      const monthlyData = await yahooFinance.historical(ticker, {
        period1: period1Str,
        period2: new Date(),
        interval: '1mo',
      });
      
      if (monthlyData && monthlyData.length > 0) {
        const closesMonthly = monthlyData.map((d) => d.close);
        const macdInput = {
          values: closesMonthly,
          fastPeriod: 12,
          slowPeriod: 26,
          signalPeriod: 9,
          SimpleMAOscillator: false,
          SimpleMASignal: false
        };
        const macdResult = MACD.calculate(macdInput);
        const currentMACD = macdResult[macdResult.length - 1];
        
        isMacdDeadCross = !!(currentMACD && currentMACD.MACD !== undefined && currentMACD.signal !== undefined 
                             && currentMACD.MACD < currentMACD.signal);
      }
    }

    return { ticker, price: currentPrice, rsi: currentRSI, isMacdDeadCross, error: false };
  } catch (error) {
    console.error(`Error fetching ${ticker}:`, error);
    return { ticker, price: 0, rsi: 50, isMacdDeadCross: false, error: true };
  }
}

export default async function Dashboard(props: any) {
  const searchParams = await props.searchParams;
  
  const rawCustom = searchParams?.customTicker?.trim();
  const rawSelect = searchParams?.ticker;
  const selectedTicker = (rawCustom ? rawCustom : (rawSelect || 'QQQ')).toUpperCase();

  const dateTwoYearsAgo = new Date();
  dateTwoYearsAgo.setFullYear(dateTwoYearsAgo.getFullYear() - 2);
  const period1Str = dateTwoYearsAgo.toISOString().split('T')[0];

  const[vixDataRaw, qqqData, spyData, smhData, selectedData] = await Promise.all([
    yahooFinance.quote('^VIX').catch(() => ({ regularMarketPrice: 0 })),
    getTickerData('QQQ', period1Str, false),
    getTickerData('SPY', period1Str, false),
    getTickerData('SMH', period1Str, false),
    getTickerData(selectedTicker, period1Str, true) 
  ]);

  const vixPrice = vixDataRaw.regularMarketPrice || 0;

  // ==========================================
  // 🧠 AI 量化决策引擎逻辑 (V5.0 核心新增)
  // ==========================================
  
  let score = 0;
  let marketState = "中性 (观望)";
  let stateColor = "text-gray-500";
  let positionAdv = "0% (空仓等待)";
  let leapsStrike = 0;
  let leapsDateStr = "-";
  let leapsRisk = "-";
  let strategyType = "观望";

  if (!selectedData.error) {
    // 1. 评分计算 (满分 100)
    // 1a. RSI 得分 (满分 50: 越超卖分越高)
    let rsiScore = 0;
    if (selectedData.rsi <= 30) rsiScore = 50;
    else if (selectedData.rsi <= 35) rsiScore = 40;
    else if (selectedData.rsi <= 40) rsiScore = 20;
    else if (selectedData.rsi <= 50) rsiScore = 10;
    
    // 1b. 趋势得分 (满分 30: 没死叉就是好趋势)
    let trendScore = selectedData.isMacdDeadCross ? 0 : 30;

    // 1c. VIX 波幅得分 (满分 20: 波动率低时买期权便宜)
    let vixScore = 0;
    if (vixPrice > 0 && vixPrice < 20) vixScore = 20;
    else if (vixPrice >= 20 && vixPrice <= 30) vixScore = 15;
    else if (vixPrice > 30 && vixPrice <= 35) vixScore = 10;
    else vixScore = 5; // 极度恐慌时，期权太贵，稍微扣分

    score = rsiScore + trendScore + vixScore;
    
    // 一票否决权 (过热时强制低分)
    if (selectedData.rsi >= 65) score = Math.min(score, 15);

    // 2. 市场状态与仓位建议
    if (selectedData.rsi < 35) {
      marketState = vixPrice > 35 ? "极度恐慌 (高波动)" : "恐慌超卖 (黄金坑)";
      stateColor = "text-green-600 font-bold";
      positionAdv = score >= 80 ? "10% (单次满额子弹)" : "5% (试探性小仓位)";
    } else if (selectedData.rsi >= 65) {
      marketState = "市场过热 (切勿追高)";
      stateColor = "text-red-500 font-bold";
      positionAdv = "0% (准备卖出 PMCC)";
    } else {
      marketState = "中性震荡 (耐心等待)";
      stateColor = "text-gray-600 font-bold";
      positionAdv = "0% (管住手)";
    }

    // 3. LEAPS 自动测算 (约 0.8 Delta 实值)
    // 根据数学模型，深度实值期权行权价约为现价的 78%~82%。我们取 0.8，并向下取整到最近的 5 整数位
    leapsStrike = Math.floor((selectedData.price * 0.8) / 5) * 5;
    
    // 测算到期日 (+2 年)
    const futureDate = new Date();
    futureDate.setFullYear(futureDate.getFullYear() + 2);
    leapsDateStr = `${futureDate.getFullYear()}年 ${futureDate.getMonth() + 1}月`;

    // 建议策略与风险级别
    if (score >= 70) {
      leapsRisk = "🟢 极佳盈亏比 (低险)";
      strategyType = "买入单腿 LEAPS 看涨";
    } else if (selectedData.rsi < 35 && vixPrice > 35) {
      leapsRisk = "🟡 波动率杀跌风险 (中险)";
      strategyType = "买入 Bull Call Spread 价差 (对冲高VIX)";
    } else if (selectedData.rsi >= 65) {
      leapsRisk = "🔴 追高吃套风险 (高险)";
      strategyType = "卖出虚值 Short Call 收租";
    } else {
      leapsRisk = "⚪ 盈亏比平庸 (中性)";
      strategyType = "无操作";
    }
  }

  const topCards =[
    { name: 'QQQ (纳指)', data: qqqData },
    { name: 'SPY (标普)', data: spyData },
    { name: 'SMH (半导体)', data: smhData }
  ];

  return (
    <main className="min-h-screen bg-gray-50 p-6 md:p-8 font-sans">
      <div className="max-w-4xl mx-auto">
        
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-gray-900 mb-1">量化 LEAPS 决策引擎</h1>
          <p className="text-gray-500 text-sm">V5.0 AI 自动测算仪 | 每日更新</p>
        </div>

        {/* --- 第一区：常驻显示核心三剑客 + VIX --- */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          {topCards.map((item) => (
            <div key={item.name} className="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
              <h3 className="text-gray-500 text-xs font-semibold">{item.name}</h3>
              <p className="text-xl font-bold text-gray-900 my-1">${item.data.price.toFixed(2)}</p>
              <p className="text-xs font-medium flex justify-between">
                <span className="text-gray-400">RSI:</span>
                <span className={item.data.rsi < 35 ? 'text-green-600 font-bold' : item.data.rsi > 65 ? 'text-yellow-600 font-bold' : 'text-gray-700'}>
                  {item.data.rsi.toFixed(2)}
                </span>
              </p>
            </div>
          ))}
          <div className="bg-gray-900 p-4 rounded-xl shadow-sm border border-gray-700">
            <h3 className="text-gray-400 text-xs font-semibold">VIX 恐慌指数</h3>
            <p className={`text-xl font-bold my-1 ${vixPrice > 35 ? 'text-red-500' : 'text-white'}`}>
              {vixPrice.toFixed(2)}
            </p>
            <p className="text-xs font-medium text-gray-400">
              {vixPrice > 35 ? '⚠️ 高IV极度恐慌' : '✅ 波动率安全'}
            </p>
          </div>
        </div>

        {/* --- 第二区：操作面板 --- */}
        <div className="bg-white p-5 rounded-xl shadow-sm border border-blue-100 mb-6">
          <form method="GET" action="/" className="flex flex-col md:flex-row md:items-end space-y-4 md:space-y-0 md:space-x-4">
            <div className="flex flex-col space-y-2 flex-1">
              <label className="font-bold text-gray-700 text-sm">🎯 快速选择推荐 ETF</label>
              <select name="ticker" defaultValue={rawSelect || 'QQQ'} className="border border-gray-300 rounded-lg px-4 py-2 font-medium focus:ring-2 focus:ring-blue-500">
                <option value="QQQ">QQQ (纳指100 - 首选)</option>
                <option value="SPY">SPY (标普500 - 稳健)</option>
                <option value="SMH">SMH (半导体 - 高波)</option>
              </select>
            </div>
            <div className="hidden md:flex text-gray-300 font-bold pb-2">或</div>
            <div className="flex flex-col space-y-2 flex-1">
              <label className="font-bold text-gray-700 text-sm">✍️ 自定义分析</label>
              <input type="text" name="customTicker" placeholder="例如: AAPL, TSLA" defaultValue={rawCustom || ''} className="border border-gray-300 rounded-lg px-4 py-2 font-medium uppercase placeholder-gray-400 focus:ring-2 focus:ring-blue-500" />
            </div>
            <button type="submit" className="bg-blue-600 text-white px-6 py-2 rounded-lg font-bold hover:bg-blue-700 transition">探测</button>
          </form>
        </div>

        {/* --- 第三区：AI 决策核心仪表盘 --- */}
        {!selectedData.error && (
          <div className="bg-white border-2 border-gray-800 rounded-2xl shadow-xl overflow-hidden mb-8">
            {/* 头部标题区域 */}
            <div className={`px-6 py-4 flex justify-between items-center ${score >= 70 ? 'bg-green-600 text-white' : score >= 40 ? 'bg-gray-800 text-white' : 'bg-red-600 text-white'}`}>
              <div>
                <p className="text-sm opacity-80 uppercase tracking-wider">AI 诊断报告</p>
                <h2 className="text-3xl font-black mt-1">{selectedTicker} <span className="font-light text-2xl">| ${selectedData.price.toFixed(2)}</span></h2>
              </div>
              {/* 大圆圈分数 */}
              <div className="text-right flex flex-col items-end">
                <div className="w-16 h-16 rounded-full border-4 border-white/30 flex items-center justify-center text-2xl font-black shadow-inner bg-black/20">
                  {score}
                </div>
                <p className="text-xs mt-1 font-medium opacity-90">交易评分 (满分100)</p>
              </div>
            </div>

            {/* 4宫格核心数据 */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-gray-200">
              <div className="bg-white p-5">
                <p className="text-xs text-gray-400 font-bold uppercase tracking-wide">当前状态</p>
                <p className={`text-lg mt-1 ${stateColor}`}>{marketState}</p>
                <p className="text-xs text-gray-500 mt-2">RSI: {selectedData.rsi.toFixed(1)}</p>
              </div>
              <div className="bg-white p-5">
                <p className="text-xs text-gray-400 font-bold uppercase tracking-wide">建议仓位</p>
                <p className={`text-lg font-bold mt-1 ${score >= 60 ? 'text-blue-600' : 'text-gray-800'}`}>{positionAdv}</p>
                <p className="text-xs text-gray-500 mt-2">本周总限额: 1发子弹</p>
              </div>
              <div className="bg-white p-5">
                <p className="text-xs text-gray-400 font-bold uppercase tracking-wide">推荐合约 (DTE & Strike)</p>
                {score >= 60 ? (
                  <>
                    <p className="text-lg font-black text-gray-900 mt-1">{leapsDateStr}</p>
                    <p className="text-sm font-bold text-blue-600">行权价 ≈ ${leapsStrike}</p>
                  </>
                ) : (
                  <p className="text-lg font-bold text-gray-400 mt-1">无需开仓</p>
                )}
              </div>
              <div className="bg-white p-5">
                <p className="text-xs text-gray-400 font-bold uppercase tracking-wide">策略与风险</p>
                <p className="text-sm font-bold text-gray-800 mt-1">{strategyType}</p>
                <p className="text-xs text-gray-500 mt-2">风险: {leapsRisk}</p>
              </div>
            </div>
          </div>
        )}

        {selectedData.error && (
          <div className="p-6 bg-red-100 text-red-800 rounded-xl shadow mb-8">
            ❌ 无法获取 [{selectedTicker}] 的数据。请检查代码是否输入正确。
          </div>
        )}

        {/* --- 第四区：风控规则备忘录 --- */}
        <div className="bg-blue-50/50 border border-blue-200 p-5 rounded-xl text-sm text-blue-900">
          <h4 className="font-bold mb-3 text-blue-800 flex items-center">
            <span className="mr-2">📌</span> 纪律备忘录 (铁律)
          </h4>
          <ul className="list-disc pl-6 space-y-2 opacity-90">
            <li><strong>防暴雷：</strong> 本策略主要针对宽基指数（ETF）。如果查询的是**个股**，必须先确保它没有重大基本面问题！</li>
            <li><strong>阶梯止盈：</strong> 持仓 &lt;12个月赚 100% | 12-15个月赚 50% | 16-18个月赚 30%。</li>
            <li><strong>强制时间止损：</strong> 任何期权距离到期日 <strong>&lt; 6 个月 (约180天)</strong> 时，无条件平仓。</li>
            <li><strong>卖 Call 警告：</strong> 对于个股，做 PMCC 卖短期 Call 时<strong>绝对避开财报周</strong>，以防被财报利好拉爆。</li>
          </ul>
        </div>

      </div>
    </main>
  );
}