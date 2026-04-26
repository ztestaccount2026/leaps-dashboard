import YahooFinance from 'yahoo-finance2';
import { RSI, MACD, SMA } from 'technicalindicators';

const yahooFinance = new YahooFinance();

export const revalidate = 0; 

// 通用数据获取与核心指标计算函数 (含回测系统)
async function getTickerData(ticker: string, period1Str: string, includeAdvanced = false) {
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

    // 默认返回值
    let result: any = { ticker, price: currentPrice, rsi: currentRSI, error: false };

    // --- 高级数据计算 (用于选中的标的) ---
    if (includeAdvanced) {
      // 1. 月线 MACD 死叉判断
      const monthlyData = await yahooFinance.historical(ticker, {
        period1: period1Str,
        period2: new Date(),
        interval: '1mo',
      });
      let isMacdDeadCross = false;
      if (monthlyData && monthlyData.length > 0) {
        const closesMonthly = monthlyData.map((d) => d.close);
        const macdResult = MACD.calculate({ values: closesMonthly, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
        const currentMACD = macdResult[macdResult.length - 1];
        isMacdDeadCross = !!(currentMACD && currentMACD.MACD !== undefined && currentMACD.signal !== undefined && currentMACD.MACD < currentMACD.signal);
      }
      result.isMacdDeadCross = isMacdDeadCross;

      // 2. 均线计算 (MA50, MA200)
      const sma50 = SMA.calculate({ values: closesDaily, period: 50 });
      const sma200 = SMA.calculate({ values: closesDaily, period: 200 });
      result.ma50 = sma50.length > 0 ? sma50[sma50.length - 1] : 0;
      result.ma200 = sma200.length > 0 ? sma200[sma200.length - 1] : 0;

      // 3. 历史波动率 (HV) 计算 (近20日收益率的标准差年化)
      let returns =[];
      for(let i = closesDaily.length - 20; i < closesDaily.length; i++) {
        if(i > 0) returns.push((closesDaily[i] - closesDaily[i-1]) / closesDaily[i-1]);
      }
      const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((a, b) => a + Math.pow(b - meanReturn, 2), 0) / returns.length;
      const hv = Math.sqrt(variance) * Math.sqrt(252) * 100; // 转化为年化百分比
      result.hv = hv;

      // 4. 实时沙盒回测：过去2年 RSI<35 策略胜率 (持有 6 个月 / 120 个交易日)
      let rsiSignals = 0;
      let wins = 0;
      let lastSignalIdx = -999;
      // rsiResult 数组长度 = closesDaily.length - 14
      for (let k = 0; k < rsiResult.length - 120; k++) {
        // 如果 RSI < 35，并且距离上次触发超过 15 个交易日（避免连续震荡重复统计）
        if (rsiResult[k] < 35 && (k - lastSignalIdx) > 15) {
          rsiSignals++;
          const entryPrice = closesDaily[k + 14]; 
          const exitPrice = closesDaily[k + 14 + 120]; // 模拟 6 个月后卖出
          if (exitPrice > entryPrice) wins++;
          lastSignalIdx = k;
        }
      }
      result.backtest = {
        signals: rsiSignals,
        wins: wins,
        winRate: rsiSignals > 0 ? ((wins / rsiSignals) * 100).toFixed(0) : "N/A"
      };
    }

    return result;
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
  // 🧠 AI 量化决策引擎逻辑 (V5.0/V6.0)
  // ==========================================
  let score = 0;
  let marketState = "中性 (观望)";
  let stateColor = "text-gray-500";
  let positionAdv = "0% (空仓等待)";
  let leapsStrike = 0;
  let leapsDateStr = "-";
  let leapsRisk = "-";
  let strategyType = "观望";

  // PMCC 动态计算变量
  let pmccStrike = 0;
  let pmccDateStr = "-";

  if (!selectedData.error) {
    // 1. 评分计算
    let rsiScore = selectedData.rsi <= 30 ? 50 : selectedData.rsi <= 35 ? 40 : selectedData.rsi <= 40 ? 20 : selectedData.rsi <= 50 ? 10 : 0;
    
    // 趋势过滤：MA50 > MA200 并且没死叉，趋势拿满分。如果在均线下方，减分。
    let trendScore = selectedData.isMacdDeadCross ? 0 : 20;
    if (selectedData.ma50 > selectedData.ma200) trendScore += 10;

    let vixScore = (vixPrice > 0 && vixPrice < 20) ? 20 : (vixPrice <= 30) ? 15 : (vixPrice <= 35) ? 10 : 5;

    score = rsiScore + trendScore + vixScore;
    if (selectedData.rsi >= 65) score = Math.min(score, 15);

    // 2. 状态判断
    if (selectedData.rsi < 35) {
      marketState = vixPrice > 35 ? "极度恐慌 (高波)" : "恐慌超卖 (黄金坑)";
      stateColor = "text-green-600 font-bold";
      positionAdv = score >= 80 ? "10% (单次满额)" : "5% (试探小仓位)";
    } else if (selectedData.rsi >= 65) {
      marketState = "市场过热 (切勿追高)";
      stateColor = "text-red-500 font-bold";
      positionAdv = "0% (准备做PMCC)";
    } else {
      marketState = "中性震荡 (耐心等待)";
      stateColor = "text-gray-600 font-bold";
      positionAdv = "0% (管住手)";
    }

    // 3. LEAPS 计算 (约 0.8 Delta 实值)
    leapsStrike = Math.floor((selectedData.price * 0.8) / 5) * 5;
    const futureDate = new Date();
    futureDate.setFullYear(futureDate.getFullYear() + 2);
    leapsDateStr = `${futureDate.getFullYear()}年 ${futureDate.getMonth() + 1}月`;

    // 4. PMCC 动态参数计算 (Short Call)
    // 根据该股票自己的 HV(历史波动率) 动态计算虚值程度。波动率越大，卖得越远。
    // 一般 0.15 Delta 大约在现价上方 (HV * 0.25) 的位置
    const otmRatio = 1 + (selectedData.hv / 100) * 0.25; 
    pmccStrike = Math.ceil((selectedData.price * otmRatio) / 2.5) * 2.5; // 向上取整到 2.5 的倍数
    
    const pmccDate = new Date();
    pmccDate.setDate(pmccDate.getDate() + 45); // 推荐卖 45 天到期
    pmccDateStr = `${pmccDate.getMonth() + 1}月${pmccDate.getDate()}日 (约45 DTE)`;

    if (score >= 70) {
      leapsRisk = "🟢 极佳盈亏比 (低险)";
      strategyType = "买入单腿 LEAPS";
    } else if (selectedData.rsi < 35 && vixPrice > 35) {
      leapsRisk = "🟡 波动率杀跌 (中险)";
      strategyType = "买入价差对冲高VIX";
    } else if (selectedData.rsi >= 65) {
      leapsRisk = "🔴 追高吃套风险 (高险)";
      strategyType = "卖出虚值 Short Call";
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
    <main className="min-h-screen bg-gray-100 p-4 md:p-8 font-sans">
      <div className="max-w-5xl mx-auto space-y-6">
        
        {/* --- 顶部 Header --- */}
        <div>
          <h1 className="text-3xl font-black text-gray-900 tracking-tight">机构级 LEAPS 交易中枢</h1>
          <p className="text-gray-500 text-sm mt-1">V6.0 自动回测与 PMCC 参数机 | 实时量化支持</p>
        </div>

        {/* --- 第一区：大盘核心数据 --- */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {topCards.map((item) => (
            <div key={item.name} className="bg-white p-4 rounded-xl shadow-sm border-l-4 border-blue-500">
              <h3 className="text-gray-500 text-xs font-semibold">{item.name}</h3>
              <p className="text-xl font-bold text-gray-900 my-1">${item.data.price.toFixed(2)}</p>
              <p className="text-xs font-medium text-gray-500 flex justify-between">
                <span>RSI:</span>
                <span className={item.data.rsi < 35 ? 'text-green-600 font-bold' : item.data.rsi > 65 ? 'text-red-500 font-bold' : ''}>
                  {item.data.rsi.toFixed(2)}
                </span>
              </p>
            </div>
          ))}
          <div className="bg-gray-900 p-4 rounded-xl shadow-sm border-l-4 border-red-500 text-white">
            <h3 className="text-gray-400 text-xs font-semibold">VIX (波动率基准)</h3>
            <p className={`text-xl font-bold my-1 ${vixPrice > 35 ? 'text-red-400' : 'text-green-400'}`}>
              {vixPrice.toFixed(2)}
            </p>
            <p className="text-xs font-medium opacity-80">
              {vixPrice > 35 ? '恐慌极值，适合卖期权' : '波动率健康'}
            </p>
          </div>
        </div>

        {/* --- 第二区：标的选择器 --- */}
        <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-200">
          <form method="GET" action="/" className="flex flex-col md:flex-row md:items-end space-y-4 md:space-y-0 md:space-x-4">
            <div className="flex flex-col space-y-2 flex-1">
              <label className="font-bold text-gray-700 text-sm">🎯 基础白马池</label>
              <select name="ticker" defaultValue={rawSelect || 'QQQ'} className="border border-gray-300 rounded-lg px-4 py-2 font-medium focus:ring-2 focus:ring-blue-500 bg-gray-50">
                <option value="QQQ">QQQ (纳斯达克100)</option>
                <option value="SPY">SPY (标普500)</option>
                <option value="SMH">SMH (半导体ETF)</option>
              </select>
            </div>
            <div className="hidden md:flex text-gray-400 font-bold pb-2 text-sm">OR</div>
            <div className="flex flex-col space-y-2 flex-1">
              <label className="font-bold text-gray-700 text-sm">✍️ 精确打击 (输入代码)</label>
              <input type="text" name="customTicker" placeholder="e.g., TSLA, NVDA" defaultValue={rawCustom || ''} className="border border-gray-300 rounded-lg px-4 py-2 font-medium uppercase focus:ring-2 focus:ring-blue-500" />
            </div>
            <button type="submit" className="bg-black text-white px-8 py-2 rounded-lg font-bold hover:bg-gray-800 transition">执行分析</button>
          </form>
        </div>

        {!selectedData.error && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            
            {/* --- 第三区：AI 交易决策 (占据左侧 2 列) --- */}
            <div className="lg:col-span-2 bg-white rounded-2xl shadow-md border border-gray-200 overflow-hidden">
              <div className={`px-6 py-5 flex justify-between items-center ${score >= 70 ? 'bg-green-600 text-white' : score >= 40 ? 'bg-gray-800 text-white' : 'bg-red-600 text-white'}`}>
                <div>
                  <p className="text-xs opacity-80 uppercase tracking-widest mb-1">主控面板</p>
                  <h2 className="text-3xl font-black">{selectedTicker} <span className="font-light text-2xl ml-2">| ${selectedData.price.toFixed(2)}</span></h2>
                </div>
                <div className="text-right flex flex-col items-end">
                  <div className="w-16 h-16 rounded-full border-4 border-white/30 flex items-center justify-center text-3xl font-black shadow-inner bg-black/20">
                    {score}
                  </div>
                  <p className="text-xs mt-1 font-medium opacity-90">量化评分</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-px bg-gray-100">
                <div className="bg-white p-6 flex flex-col justify-between">
                  <div>
                    <p className="text-xs text-gray-400 font-bold uppercase">资金调度 & 核心指标</p>
                    <p className={`text-xl font-bold mt-1 ${score >= 60 ? 'text-blue-600' : 'text-gray-800'}`}>{positionAdv}</p>
                  </div>
                  <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100">
                    <p className={`text-sm font-medium ${stateColor}`}>{marketState}</p>
                    {/* 👇 新增的 RSI 动态标签 */}
                    <div className="bg-gray-50 px-2 py-1 rounded text-sm font-bold border border-gray-200 shadow-sm">
                      <span className="text-gray-500 mr-1">RSI:</span>
                      <span className={selectedData.rsi < 35 ? 'text-green-600' : selectedData.rsi > 65 ? 'text-red-500' : 'text-gray-800'}>
                        {selectedData.rsi.toFixed(2)}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="bg-white p-6">
                  <p className="text-xs text-gray-400 font-bold uppercase">做多推荐 (LEAPS 买入单)</p>
                  {score >= 60 ? (
                    <>
                      <p className="text-xl font-black text-gray-900 mt-1">{leapsDateStr}</p>
                      <p className="text-sm font-bold text-blue-600 mt-1">行权价 (Strike) ≈ ${leapsStrike}</p>
                    </>
                  ) : (
                    <p className="text-lg font-bold text-gray-400 mt-1">当前不满足建仓条件</p>
                  )}
                </div>
              </div>
            </div>

            {/* --- 第四区：高级技术与策略 (占据右侧 1 列) --- */}
            <div className="space-y-6">
              
              {/* 卡片 A: 趋势与波动过滤 */}
              <div className="bg-white p-5 rounded-2xl shadow-md border border-gray-200">
                <h3 className="text-sm font-black text-gray-800 border-b pb-2 mb-3">📈 趋势与波动 (Filter)</h3>
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">长线趋势 (MA200):</span>
                    <span className={`font-bold ${selectedData.price > selectedData.ma200 ? 'text-green-600' : 'text-red-500'}`}>
                      {selectedData.price > selectedData.ma200 ? '多头区间 (牛)' : '空头区间 (熊)'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">均线排列:</span>
                    <span className="font-bold text-gray-800">
                      {selectedData.ma50 > selectedData.ma200 ? '金叉状态' : '死叉状态'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">标的历史波动率 (HV):</span>
                    <span className="font-bold text-purple-600">{selectedData.hv.toFixed(1)}%</span>
                  </div>
                </div>
              </div>

              {/* 卡片 B: 策略回测报告 */}
              <div className="bg-gradient-to-br from-gray-900 to-gray-800 p-5 rounded-2xl shadow-md text-white">
                <h3 className="text-sm font-black text-blue-300 border-b border-gray-600 pb-2 mb-3">🧪 RSI&lt;35 历史回测 (2年)</h3>
                <div className="text-center py-2">
                  <p className="text-xs text-gray-400">买入并持有 6 个月胜率</p>
                  <p className="text-4xl font-black text-green-400 mt-1">
                    {selectedData.backtest.winRate}{selectedData.backtest.winRate !== "N/A" ? "%" : ""}
                  </p>
                  <p className="text-xs text-gray-300 mt-2">触发次数: {selectedData.backtest.signals} 次 | 获利次数: {selectedData.backtest.wins} 次</p>
                </div>
              </div>

            </div>
          </div>
        )}

        {/* --- 第五区：PMCC 动态参数与滚仓辅助 (全宽) --- */}
        {!selectedData.error && (
          <div className="bg-white rounded-2xl shadow-md border border-gray-200 overflow-hidden">
            <div className="bg-yellow-50 px-6 py-4 border-b border-yellow-200 flex items-center">
              <span className="text-2xl mr-2">🪙</span>
              <div>
                <h3 className="font-bold text-yellow-900">PMCC 对冲计算器 (降本增效套件)</h3>
                <p className="text-xs text-yellow-700">适用于已持有 LEAPS，且当前股价反弹至 RSI &gt; 65 的过热阶段。</p>
              </div>
            </div>
            <div className="p-6 grid grid-cols-1 md:grid-cols-3 gap-6">
              <div>
                <p className="text-xs text-gray-400 font-bold uppercase">卖出短期 Call 推荐参数</p>
                <p className="text-lg font-black text-gray-900 mt-2">日期: {pmccDateStr}</p>
                <p className="text-lg font-black text-gray-900 mt-1">行权价 ≈ ${pmccStrike}</p>
                <p className="text-xs text-gray-500 mt-1">* 结合了该标的 HV 动态计算出的虚值点位。</p>
              </div>
              <div className="md:col-span-2 border-t md:border-t-0 md:border-l border-gray-100 pt-4 md:pt-0 md:pl-6">
                <p className="text-xs text-gray-400 font-bold uppercase mb-2">🔄 智能滚仓与风控准则</p>
                <ul className="text-sm text-gray-700 space-y-2 list-disc pl-4">
                  <li><strong>何时滚仓 (Roll)：</strong> 当标的暴涨，距离你卖出的 Short Call <strong>行权价不足 2%</strong> 时，立即平仓并<strong>向后、向上</strong>卖出下一个月的虚值 Call (Roll Up and Out)。</li>
                  <li><strong>何时平仓 (Close)：</strong> 当期权距离到期 <strong>不足 14 天</strong>，且未被击穿，其时间价值已榨干，直接平仓买回，重新开下个月的。</li>
                  <li><strong>财报避险：</strong> 绝不允许卖出的 Short Call 跨越该公司的财报发布日！</li>
                </ul>
              </div>
            </div>
          </div>
        )}

        {selectedData.error && (
          <div className="p-6 bg-red-100 text-red-800 rounded-xl shadow font-bold text-center">
            ❌ 数据提取失败，请检查输入的股票代码是否正确（美股请直接输入字母）。
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