const NUMBER = '(?:[\\d零一二两三四五六七八九十百千点.]+)'
const NAVIGATION = [
    `(在|前方|向前|沿当前道路|沿.{1,8}?路)?(继续)?(直行|行驶|走)?${NUMBER}(米|公里|千米)(后|处|左右)?`,
    '(左转|右转|掉头|调头|直行|靠左|靠右|左前方|右前方|并线|汇入)',
    '(进入|驶入|驶出|驶离|走|保持|靠)(最?左侧?|最?右侧?|中间)?的?.{0,8}?(匝道|主路|辅路|环岛|高架|隧道|收费站|服务区|车道|出口|入口|高速|路口|立交)',
    '前方.{0,10}?(路口|出口|测速|摄像头|电子眼|拍照|监控|闯红灯|违章|事故多发|拥堵|施工|急转弯|连续弯路|人行横道|学校|红绿灯)+',
    '减速慢行|注意安全|谨慎驾驶|小心驾驶',
    `(限速|区间测速|已超速)${NUMBER}?(公里)?`,
    '(已为您|正在为您).{0,6}?(规划|躲避|选择)|重新规划路线|躲避拥堵|更快路线|已偏航',
    '导航结束|本次导航|到达目的地|目的地(在|附近|就在)',
    `\\b(in|after|for) ${NUMBER} ?(feet|ft|meters?|metres?|miles?|mi|kilometers?|km|yards?)\\b`,
    '\\b(turn|keep|bear|stay|merge|slight|sharp) (left|right)( (onto|on|at)( [a-z0-9]+){1,4})?\\b',
    '\\b(make a u ?turn|rerouting|you have arrived( at (your|the) destination)?|your destination is|speed camera|take the (exit|ramp)|continue straight)\\b',
].join('|')
const FILLER = '然后|随后|并|再|请|您|注意|继续|即可|的|和|就|了|大约|约|\\b(then|and|the|on the (left|right))\\b'

/**
 * True when the transcript is only a car-navigation announcement (Amap, Baidu, Google Maps, Apple Maps).
 * These come from another app, so browser echo cancellation never removes them.
 */
export function isNavigationPrompt(text: string): boolean {
    const heard = text.toLowerCase().replace(/[\p{P}\p{S}]/gu, ' ')
    if (!new RegExp(NAVIGATION, 'iu').test(heard)) return false
    return heard.replace(new RegExp(`${NAVIGATION}|${FILLER}`, 'giu'), '').replace(/\s/g, '').length <= 2
}
