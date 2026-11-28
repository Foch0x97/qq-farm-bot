const itemIconRoot = '/game-config/seed_images_named/seed_images'

export const MAPLE_MARKET_ICON = '/activity-assets/maple-market/entry.png'
export const MAPLE_MARKET_CURRENCY_ICON = `${itemIconRoot}/1033.png`

export const MAPLE_MARKET_GOODS = [
  { id: 204013, name: '七彩花弦', price: 1000000, limit: 1 },
  { id: 101627, name: '福气金豆礼包', price: 60000, limit: 28 },
  { id: 20522, name: '金币果', price: 40000, limit: 40 },
  { id: 20523, name: '经验蘑菇', price: 40000, limit: 40 },
  { id: 80011, name: '有机化肥（1 小时）', price: 8500, limit: 50 },
  { id: 101620, name: '南瓜种子礼包', price: 28000, limit: 10 },
  { id: 101621, name: '荷风种子礼包', price: 28000, limit: 10 },
  { id: 101622, name: '千星种子礼包', price: 28000, limit: 10 },
  { id: 101623, name: '萌宠种子礼包', price: 35000, limit: 10 },
  { id: 80001, name: '化肥（1 小时）', price: 7000, limit: 50 },
].map((item, index) => ({ ...item, index: index + 1, image: `${itemIconRoot}/${item.id}.png` }))
