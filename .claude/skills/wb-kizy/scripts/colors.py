# -*- coding: utf-8 -*-
"""Единый справочник цветов: объединяем синонимы и выбираем одно написание."""
import sys, re
sys.path.insert(0,'/home/user/wb-headless/.claude/skills/wb-kizy/scripts')
import kiz_lib as K
from collections import Counter, defaultdict

# опечатки, которые нельзя развести автоматически (двойная буква в корне)
TYPO = {'корраловый': 'коралловый'}
# одиночные формы женского рода приводим к мужскому: в справочнике одна форма
FEM = (('ая', 'ый'), ('яя', 'ий'))

def tidy(s):
    s = str(s).replace('ё','е').replace('Ё','Е')
    s = re.sub(r'["«»\']','', s)
    s = re.sub(r'[_/\\]+',' ', s)
    s = re.sub(r'\s+',' ', s).strip(' ,.')
    words = [TYPO.get(w, w) for w in s.lower().split()]
    if words:
        for a, b in FEM:
            if words[-1].endswith(a) and len(words[-1]) > 4:
                words[-1] = words[-1][:-len(a)] + b
                break
    s = ' '.join(words)
    return s[:1].upper() + s[1:] if s else s

def from_article(art):
    """Цветовая часть артикула: убираем номер и служебные коды, дефисы бережём."""
    s = re.sub(r'^\D*\d{3}','', str(art))
    s = re.sub(r'[_/\\]+',' ', s)
    out = []
    for w in s.split():
        low = w.lower()
        if low in K.STOP or low.split('-')[0] in K.STOP:
            continue
        out.append(w)
    return tidy(' '.join(out))

class Dict_:
    """Группируем написания цветов: связываем те, что матчер считает тождественными."""
    def __init__(self):
        self.variants = []           # (текст, приоритет источника)
        self.canon = {}

    def add(self, text, tier):
        if text and str(text).strip():
            self.variants.append((str(text).strip(), tier))

    @staticmethod
    def _same(a, b):
        """Строже общего матчера: короткие основы должны совпасть точно.

        Иначе сокращение «Кор/сер» {кор, сер} склеивается с «коричневое
        сердечко» {коричнев, сердечк} — три первые буквы совпадают у обоих.
        """
        if not a or not b or len(a) != len(b): return False
        used = set()
        for t in a:
            ok = False
            for j, u in enumerate(b):
                if j in used: continue
                if t == u or (len(t) >= 4 and len(u) >= 4 and
                              t[:min(len(t), len(u))] == u[:min(len(t), len(u))]):
                    used.add(j); ok = True; break
            if not ok: return False
        return True

    def build(self):
        toks = [K.color_tokens(v) for v, _ in self.variants]
        n = len(self.variants)
        parent = list(range(n))
        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]; x = parent[x]
            return x
        def union(a, b):
            ra, rb = find(a), find(b)
            if ra != rb: parent[rb] = ra
        for i in range(n):
            for j in range(i+1, n):
                if self._same(toks[i], toks[j]):
                    union(i, j)
        groups = defaultdict(list)
        for i in range(n): groups[find(i)].append(i)
        fem = re.compile(r'(ая|яя)$')
        for members in groups.values():
            cands = {}
            for i in members:
                v, t = self.variants[i]
                text = tidy(v)
                # женский род проигрывает мужскому/существительному: в
                # справочнике держим одну форму, «Белый», а не «Белая»
                words = text.lower().split()
                pen = 1 if words and fem.search(words[-1]) else 0
                key = (pen, t, len(text), text)
                if text not in cands or key < cands[text]: cands[text] = key
            display = min(cands.items(), key=lambda x: x[1])[0]
            for i in members:
                self.canon[tuple(toks[i])] = display
                self.canon[self.variants[i][0]] = display
        return self

    def get(self, text, fallback=None):
        t = tuple(K.color_tokens(text))
        return self.canon.get(str(text).strip()) or self.canon.get(t) or tidy(fallback or text)
