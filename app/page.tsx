import YahooFinance from 'yahoo-finance2';
import { RSI, MACD } from 'technicalindicators';

const yahooFinance = new YahooFinance();

// 禁用缓存，确保每次访问都是最新数据
export const revalidate = 0; 

// 通用数据获取与指标计算函数
async function getTickerData(ticker: string, period1Str: string, includeMonthly = false) {
  try {
    // 💡 融合了你发现的完美解法：显式传入 period2: new Date()
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

    // 月线 MACD 计算 (判断大级别趋势)
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

// 页面主组件
export default async function Dashboard(props: any) {
  const searchParams = await props.searchParams;
  
  // 🚀 核心逻辑：优先读取自定义输入框，如果没有，则读取下拉菜单，默认 QQQ
  const rawCustom = searchParams?.customTicker?.trim();
  const rawSelect = searchParams?.ticker;
  const selectedTicker = (rawCustom ? rawCustom : (rawSelect || 'QQQ')).toUpperCase();

  // 生成两年前的日期作为起点
  const dateTwoYearsAgo = new Date();
  dateTwoYearsAgo.setFullYear(dateTwoYearsAgo.getFullYear() - 2);
  const period1Str = dateTwoYearsAgo.toISOString().split('T')[0];

  // 并行请求核心数据 + 用户选中的自定义数据
  const[vixDataRaw, qqqData, spyData, smhData, selectedData] = await Promise.all([
    yahooFinance.quote('^VIX').catch(() => ({ regularMarketPrice: 0 })),
    getTickerData('QQQ', period1Str, false),
    getTickerData('SPY', period1Str, false),
    getTickerData('SMH', period1Str, false),
    getTickerData(selectedTicker, period1Str, true) 
  ]);

  const vixPrice = vixDataRaw.regularMarketPrice || 0;

  // --- 生成当前选中标的的策略信号 ---
  let signal = "⏳ 观望 / 持仓待涨";
  let actionColor = "bg-gray-100 text-gray-800";
  let details = `当前 ${selectedTicker} 市场情绪稳定，没有触发极端买卖信号。`;

  if (selectedData.error) {
    signal = "❌ 数据获取失败";
    actionColor = "bg-red-100 text-red-800";
    details = `无法获取[${selectedTicker}] 的数据。请检查代码是否输入正确（如需查询美股，请直接输入代码如 AAPL；加密货币如 BTC-USD）。`;
  } else if (selectedData.isMacdDeadCross) {
    signal = `🚨 警报：${selectedTicker} 月线MACD死叉！`;
    actionColor = "bg-red-600 text-white";
    details = "长牛趋势可能被破坏（或正处于长线熊市中），建议暂停买入计划，考虑清仓该标的的 LEAPS 止损。";
  } else if (selectedData.rsi < 35) {
    if (vixPrice > 35) {
      signal = `⚠️ VIX极高：买入 ${selectedTicker} 看涨期权价差`;
      actionColor = "bg-purple-600 text-white";
      details = `${selectedTicker} 已超卖(RSI<35)，但恐慌指数极高(VIX>35)。期权极其昂贵，请买入 0.8 Delta Call 并卖出 0.4 Delta Call 对冲高波动率。`;
    } else {
      signal = `🟢 黄金坑：买入 ${selectedTicker} 2年期 LEAPS`;
      actionColor = "bg-green-600 text-white";
      details = `${selectedTicker} 已超卖(RSI: ${selectedData.rsi.toFixed(1)})且VIX适中。请买入 DTE 700-800天，Delta 0.8+ 的深度实值 Call。每周限买1次！`;
    }
  } else if (selectedData.rsi > 65) {
    signal = `🟡 薅羊毛：准备卖出 ${selectedTicker} 短期 Call`;
    actionColor = "bg-yellow-500 text-black";
    details = `${selectedTicker} 进入超买区(RSI: ${selectedData.rsi.toFixed(1)})。可择机卖出 DTE 30-45天，Delta 0.15-0.20 的虚值 Call 收取权利金 (PMCC)。`;
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
          <h1 className="text-3xl font-bold text-gray-900 mb-1">全天候 LEAPS 策略雷达</h1>
          <p className="text-gray-500 text-sm">V4.0 自定义扫雷仪 | 每日更新</p>
        </div>

        {/* --- 第一区：常驻显示核心三剑客 + VIX --- */}
        <h2 className="text-lg font-bold text-gray-800 mb-3 border-l-4 border-blue-500 pl-2">大盘与情绪基准</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          {topCards.map((item) => (
            <div key={item.name} className="bg-white p-4 rounded-xl shadow-sm border border-gray-200 flex flex-col justify-between">
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
          <div className="bg-gray-900 p-4 rounded-xl shadow-sm border border-gray-700 flex flex-col justify-between">
            <h3 className="text-gray-400 text-xs font-semibold">VIX 恐慌指数</h3>
            <p className={`text-xl font-bold my-1 ${vixPrice > 35 ? 'text-red-500' : 'text-white'}`}>
              {vixPrice.toFixed(2)}
            </p>
            <p className="text-xs font-medium text-gray-400">
              {vixPrice > 35 ? '⚠️ 极度恐慌' : '✅ 波动率安全'}
            </p>
          </div>
        </div>

        {/* --- 第二区：二合一操作面板（下拉 + 输入框） --- */}
        <div className="bg-white p-5 md:p-6 rounded-xl shadow-sm border border-blue-100 mb-6">
          <form method="GET" action="/" className="flex flex-col md:flex-row md:items-end space-y-4 md:space-y-0 md:space-x-4">
            
            {/* 左侧：下拉快速选择 */}
            <div className="flex flex-col space-y-2 flex-1">
              <label htmlFor="ticker" className="font-bold text-gray-700 text-sm">
                🎯 快速选择推荐 ETF
              </label>
              <select 
                name="ticker" 
                id="ticker" 
                defaultValue={rawSelect || 'QQQ'}
                className="border border-gray-300 rounded-lg px-4 py-2.5 font-medium text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-gray-50 hover:bg-white transition-colors"
              >
                <option value="QQQ">QQQ (纳指100 - 首选)</option>
                <option value="SPY">SPY (标普500 - 稳健)</option>
                <option value="SMH">SMH (半导体 - 高波)</option>
                <option value="IWM">IWM (罗素小盘股)</option>
              </select>
            </div>

            <div className="hidden md:flex text-gray-300 font-bold pb-2">或</div>

            {/* 右侧：自定义输入框 */}
            <div className="flex flex-col space-y-2 flex-1">
              <label htmlFor="customTicker" className="font-bold text-gray-700 text-sm">
                ✍️ 自定义分析 (输入股票代码)
              </label>
              <input 
                type="text" 
                name="customTicker" 
                id="customTicker"
                placeholder="例如: AAPL, TSLA, NVDA"
                defaultValue={rawCustom || ''}
                className="border border-gray-300 rounded-lg px-4 py-2.5 font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 uppercase placeholder-gray-400"
              />
            </div>

            {/* 提交按钮 */}
            <button 
              type="submit" 
              className="bg-blue-600 text-white px-6 py-2.5 rounded-lg font-bold hover:bg-blue-700 transition shadow-sm md:w-auto w-full"
            >
              探测信号
            </button>
            
          </form>
          <p className="text-xs text-gray-400 mt-3 ml-1">
            * 提示：如果输入框内有字母，系统将优先探测输入的股票。清空输入框可切回下拉菜单。
          </p>
        </div>

        {/* --- 第三区：选中标的的详细信号 --- */}
        <div className={`p-6 md:p-8 rounded-2xl shadow-lg mb-8 transition-colors duration-300 ${actionColor}`}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight">标的 [ {selectedTicker} ]：{signal}</h2>
          </div>
          <p className="text-lg opacity-95 leading-relaxed">{details}</p>
          
          <div className="mt-6 pt-4 border-t border-white/20 grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm opacity-80 mb-1">当前收盘价</p>
              <p className="text-2xl font-bold">${selectedData.price.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-sm opacity-80 mb-1">日线 RSI (14)</p>
              <p className="text-2xl font-bold">{selectedData.rsi.toFixed(2)}</p>
            </div>
          </div>
        </div>

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