import YahooFinance from 'yahoo-finance2';
import { RSI, MACD } from 'technicalindicators';

const yahooFinance = new YahooFinance();

// 禁用缓存，确保每次访问都是最新数据
export const revalidate = 0; 

async function getMarketData() {
  // 生成标准 YYYY-MM-DD 字符串作为 period1，避免 Date 对象的严格校验报错
  const dateTwoYearsAgo = new Date();
  dateTwoYearsAgo.setFullYear(dateTwoYearsAgo.getFullYear() - 2);
  const period1Str = dateTwoYearsAgo.toISOString().split('T')[0];

  // 1. 获取 QQQ 日线数据 (计算 RSI)
  const qqqDaily = await yahooFinance.historical('QQQ', {
    period1: dateTwoYearsAgo,
    period2: new Date(),
    interval: '1d',
  });
  
  // 2. 获取 QQQ 月线数据 (计算 MACD)
  const qqqMonthly = await yahooFinance.historical('QQQ', {
    period1: dateTwoYearsAgo,
    period2: new Date(),
    interval: '1mo',
  });

  // 3. 获取 VIX 最新数据
  const vixData = await yahooFinance.quote('^VIX');
  const vixPrice = vixData.regularMarketPrice || 0;

  // --- 指标计算 ---
  
  // 计算 RSI (14日)
  const closesDaily = qqqDaily.map((d) => d.close);
  const rsiInput = { values: closesDaily, period: 14 };
  const rsiResult = RSI.calculate(rsiInput);
  const currentRSI = rsiResult[rsiResult.length - 1] || 50;

  // 计算月线 MACD (12, 26, 9)
  const closesMonthly = qqqMonthly.map((d) => d.close);
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
  
  // 判断月线是否死叉 (MACD线 小于 信号线)
  const isMacdDeadCross = currentMACD && currentMACD.MACD !== undefined && currentMACD.signal !== undefined 
                          && currentMACD.MACD < currentMACD.signal;

  // --- 策略信号逻辑 ---
  let signal = "⏳ 观望 / 持仓待涨";
  let actionColor = "bg-gray-100 text-gray-800";
  let details = "当前市场情绪稳定，没有触发极端买卖信号。";

  if (isMacdDeadCross) {
    signal = "🚨 警报：月线MACD死叉！";
    actionColor = "bg-red-600 text-white";
    details = "长牛趋势可能被破坏，建议暂停所有买入计划，并考虑清仓当前LEAPS策略止损。";
  } else if (currentRSI < 35) {
    if (vixPrice > 35) {
      signal = "⚠️ VIX极高：买入看涨期权价差";
      actionColor = "bg-purple-600 text-white";
      details = "QQQ已超卖(RSI<35)，但恐慌指数极高(VIX>35)。期权极其昂贵，请买入 0.8 Delta Call 并卖出 0.4 Delta Call (Bull Call Spread) 对冲高波动率。每周限操作1次！";
    } else {
      signal = "🟢 黄金坑：买入 2年期 LEAPS";
      actionColor = "bg-green-600 text-white";
      details = "QQQ已超卖(RSI<35)且VIX适中。请买入 DTE 700-800天，Delta 0.80-0.85 的深度实值 Call。严格遵守每周限买1次纪律！";
    }
  } else if (currentRSI > 65) {
    signal = "🟡 薅羊毛：准备卖出 Short Call (PMCC)";
    actionColor = "bg-yellow-500 text-black";
    details = "QQQ进入超买区(RSI>65)，反弹强劲。可以卖出 DTE 30-45天，Delta 0.15-0.20 的虚值 Call 收取权利金。";
  }

  return {
    qqqPrice: closesDaily[closesDaily.length - 1].toFixed(2),
    vixPrice: vixPrice.toFixed(2),
    currentRSI: currentRSI.toFixed(2),
    isMacdDeadCross,
    signal,
    actionColor,
    details
  };
}

export default async function Dashboard() {
  const data = await getMarketData();

  return (
    <main className="min-h-screen bg-gray-50 p-8 font-sans">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">QQQ LEAPS 策略监控看板</h1>
        <p className="text-gray-500 mb-8">V2.0 自动信号检测系统 | 每日更新</p>

        {/* 信号提示框 */}
        <div className={`p-6 rounded-xl shadow-lg mb-8 ${data.actionColor}`}>
          <h2 className="text-2xl font-bold mb-2">今日操作：{data.signal}</h2>
          <p className="text-lg opacity-90">{data.details}</p>
        </div>

        {/* 市场数据卡片 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
            <h3 className="text-gray-500 text-sm font-medium">QQQ 最新收盘价</h3>
            <p className="text-3xl font-bold text-gray-900 mt-2">${data.qqqPrice}</p>
          </div>
          
          <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
            <h3 className="text-gray-500 text-sm font-medium">QQQ 日线 RSI (14)</h3>
            <p className={`text-3xl font-bold mt-2 ${Number(data.currentRSI) < 35 ? 'text-green-600' : Number(data.currentRSI) > 65 ? 'text-yellow-500' : 'text-gray-900'}`}>
              {data.currentRSI}
            </p>
            <p className="text-xs text-gray-400 mt-1">&lt;35 超卖 | &gt;65 超买</p>
          </div>

          <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
            <h3 className="text-gray-500 text-sm font-medium">VIX 恐慌指数</h3>
            <p className={`text-3xl font-bold mt-2 ${Number(data.vixPrice) > 35 ? 'text-red-600' : 'text-gray-900'}`}>
              {data.vixPrice}
            </p>
            <p className="text-xs text-gray-400 mt-1">&gt;35 代表极端恐慌高IV</p>
          </div>
        </div>

        {/* 规则备忘录 */}
        <div className="bg-blue-50 border-l-4 border-blue-500 p-4 rounded text-sm text-blue-800">
          <h4 className="font-bold mb-2">📌 纪律备忘录 (自行监控)：</h4>
          <ul className="list-disc pl-5 space-y-1">
            <li><strong>阶梯止盈：</strong> &lt;12个月赚100% | 12-15个月赚50% | 16-18个月赚30%</li>
            <li><strong>强制平仓：</strong> 任何期权距离到期日 <strong>&lt;6个月 (约180天)</strong> 时，无条件平仓。</li>
            <li><strong>仓位管理：</strong> 策略总仓位不超过总资产 20%，子弹分 4-5 份。</li>
          </ul>
        </div>
        
      </div>
    </main>
  );
}