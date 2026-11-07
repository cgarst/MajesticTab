// Run with: node --test tests/decodeText.test.mjs
// Fixtures are made-up sentences encoded in each code page (base64), so no tab or lyric file is committed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeText, charsetOf } from '../src/utils/decodeText.js';

const FIX = {
  gbk: ['ZXwtLTAtLXwKztLDx73xzOzIpbmr1LCjrMTjv8nS1L+0tb263LbgyMuho9XiysfSu7j2uty6w7XEyrG85KGjCg==', 'e|--0--|\n我们今天去公园，你可以看到很多人。这是一个很好的时间。\n'],
  big5: ['ZXwtLTAtLXwKp9qtzKS1pNGlaKS9tumhQadBpWmlSKzdqOyr3KZopEihQ7NvrE+kQK3Tq9ymbqq6rsm2oaFDCg==', 'e|--0--|\n我們今天去公園，你可以看到很多人。這是一個很好的時間。\n'],
  sjis: ['ZXwtLTAtLXwKjaGT+oLNk1aLQ4KqgqKCooLMgsWBQYz2iYCCyY1zgquC3IK3gUKDTYNegVuC8JJlgquC3IK1guWCpIFCCg==', 'e|--0--|\n今日は天気がいいので、公園に行きます。ギターを弾きましょう。\n'],
  euckr: ['ZXwtLTAtLXwKv8C0w8C6ILOvvr6woSDBwb7GvK0gsPi/+L+hILCptM+02S4gseLFuLimIMSovcO02S4K', 'e|--0--|\n오늘은 날씨가 좋아서 공원에 갑니다. 기타를 칩시다.\n'],
  latin1: ['T3AgMjEsIDI0IFBldGl0ZXMgUGnoY2VzIC0gQ2FyY2Fzc2kKZXwtLTAtLXwK', 'Op 21, 24 Petites Pièces - Carcassi\ne|--0--|\n'],
  utf16le: ['//5lAHwALQAtADAALQAtAHwACgARYuxOyk4pWbtTbFHtVgoA', 'e|--0--|\n我们今天去公园\n'],
  utf16be_nobom: ['AGUAfAAtAC0AMAAtAC0AfAAKAGEAYgBjACAAZABlAGYAIABnAGgAaQAK', 'e|--0--|\nabc def ghi\n'],
};
const bytes = (k) => new Uint8Array(Buffer.from(FIX[k][0], 'base64'));

for (const k of Object.keys(FIX)) {
    test(`decodes ${k} to the original text`, () => {
        assert.equal(decodeText(bytes(k)), FIX[k][1]);
    });
}

test('UTF-8, with and without a BOM, is read as UTF-8', () => {
    const text = 'e|--0--|\n晴天 Pièces\n';
    assert.equal(decodeText(new TextEncoder().encode(text)), text);
    assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)])), text);
});

test('a charset the server declared is used before guessing', () => {
    assert.equal(decodeText(bytes('gbk'), 'GB2312'), FIX.gbk[1]);
    assert.equal(decodeText(bytes('latin1'), 'iso-8859-1'), FIX.latin1[1]);
    assert.equal(decodeText(bytes('big5'), 'nonsense-charset'), FIX.big5[1]); // unknown label: falls back to the guess
});

test('charsetOf reads a Content-Type header', () => {
    assert.equal(charsetOf('text/plain; charset=gb2312'), 'gb2312');
    assert.equal(charsetOf('text/html;charset="UTF-8"; x=1'), '"UTF-8"');
    assert.equal(charsetOf('text/plain'), '');
});

test('empty and pure ASCII input', () => {
    assert.equal(decodeText(new Uint8Array()), '');
    assert.equal(decodeText(new TextEncoder().encode('e|---|')), 'e|---|');
});
