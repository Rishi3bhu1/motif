"""Render Motif's original pixel artwork. Optional maintainer tool: Python + Pillow.

Run from any directory: python docs/assets/generate-hero.py
The committed GIF/PNG need no runtime dependency. No fonts or external art used.
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent
W, H, SCALE = 600, 320, 2
BG = '#0c1019'
PANEL = '#111925'
GRID = '#18212e'
INK = '#edf0e9'
MUTED = '#8392a7'
GOLD = '#f2c36b'
DIM = '#554b37'
MINT = '#86d9b5'
BLUE = '#86b9ef'
LILAC = '#b9a3ea'

# Original 5x7 bitmap alphabet, drawn on an integer grid.
FONT = {
'A':['01110','10001','10001','11111','10001','10001','10001'],
'B':['11110','10001','10001','11110','10001','10001','11110'],
'C':['01111','10000','10000','10000','10000','10000','01111'],
'D':['11110','10001','10001','10001','10001','10001','11110'],
'E':['11111','10000','10000','11110','10000','10000','11111'],
'F':['11111','10000','10000','11110','10000','10000','10000'],
'G':['01111','10000','10000','10111','10001','10001','01111'],
'H':['10001','10001','10001','11111','10001','10001','10001'],
'I':['11111','00100','00100','00100','00100','00100','11111'],
'J':['00111','00010','00010','00010','10010','10010','01100'],
'K':['10001','10010','10100','11000','10100','10010','10001'],
'L':['10000','10000','10000','10000','10000','10000','11111'],
'M':['10001','11011','10101','10101','10001','10001','10001'],
'N':['10001','11001','11001','10101','10011','10011','10001'],
'O':['01110','10001','10001','10001','10001','10001','01110'],
'P':['11110','10001','10001','11110','10000','10000','10000'],
'Q':['01110','10001','10001','10001','10101','10010','01101'],
'R':['11110','10001','10001','11110','10100','10010','10001'],
'S':['01111','10000','10000','01110','00001','00001','11110'],
'T':['11111','00100','00100','00100','00100','00100','00100'],
'U':['10001','10001','10001','10001','10001','10001','01110'],
'V':['10001','10001','10001','10001','10001','01010','00100'],
'W':['10001','10001','10001','10101','10101','11011','10001'],
'X':['10001','10001','01010','00100','01010','10001','10001'],
'Y':['10001','10001','01010','00100','00100','00100','00100'],
'Z':['11111','00001','00010','00100','01000','10000','11111'],
'0':['01110','10001','10011','10101','11001','10001','01110'],
'1':['00100','01100','00100','00100','00100','00100','01110'],
'2':['01110','10001','00001','00010','00100','01000','11111'],
'3':['11110','00001','00001','01110','00001','00001','11110'],
'4':['00010','00110','01010','10010','11111','00010','00010'],
'5':['11111','10000','10000','11110','00001','00001','11110'],
'6':['01110','10000','10000','11110','10001','10001','01110'],
'7':['11111','00001','00010','00100','01000','01000','01000'],
'8':['01110','10001','10001','01110','10001','10001','01110'],
'9':['01110','10001','10001','01111','00001','00001','01110'],
'.':['00000','00000','00000','00000','00000','00110','00110'],
':':['00000','00100','00100','00000','00100','00100','00000'],
'/':['00001','00010','00010','00100','01000','01000','10000'],
'+':['00000','00100','00100','11111','00100','00100','00000'],
'>':['00000','10000','01000','00100','01000','10000','00000'],
'-':['00000','00000','00000','11111','00000','00000','00000'],
' ':['00000']*7,
}

def text(d, xy, value, color=INK, size=1):
    x,y=xy
    for ch in value:
        for row,bits in enumerate(FONT[ch]):
            for col,bit in enumerate(bits):
                if bit=='1':
                    d.rectangle((x+col*size,y+row*size,x+(col+1)*size-1,y+(row+1)*size-1),fill=color)
        x+=6*size

def center(d, x, y, value, color=INK, size=1):
    text(d,(x-(len(value)*6-1)*size//2,y),value,color,size)

def check(d,x,y,color=MINT):
    d.line([(x,y+3),(x+3,y+6),(x+9,y)],fill=color,width=2)

def packet(d,points,progress,color):
    lengths=[abs(b[0]-a[0])+abs(b[1]-a[1]) for a,b in zip(points,points[1:])]
    distance=(progress%1)*sum(lengths)
    for a,b,length in zip(points,points[1:],lengths):
        if distance<=length:
            p=distance/length
            x=round(a[0]+(b[0]-a[0])*p); y=round(a[1]+(b[1]-a[1])*p)
            d.rectangle((x-4,y-4,x+4,y+4),fill=PANEL)
            d.rectangle((x-2,y-2,x+2,y+2),fill=color)
            return
        distance-=length

def terminal(d,x,y,color,label,phase):
    d.rectangle((x,y,x+79,y+32),fill=PANEL,outline=GRID)
    d.line((x,y+7,x+79,y+7),fill=GRID)
    for i in range(3): d.rectangle((x+5+i*5,y+3,x+6+i*5,y+4),fill=color if i==0 else DIM)
    # A little agent sprite at its terminal.
    d.rectangle((x+8,y+14,x+23,y+25),fill=color)
    d.rectangle((x+11,y+11,x+19,y+13),fill=color)
    eye=BG if phase<.92 else color
    d.rectangle((x+11,y+17,x+13,y+19),fill=eye)
    d.rectangle((x+18,y+17,x+20,y+19),fill=eye)
    d.rectangle((x+4,y+17,x+6,y+22),fill=color)
    d.rectangle((x+25,y+17,x+27,y+22),fill=color)
    text(d,(x+36,y+15),'>',color)
    d.line((x+45,y+17,x+65,y+17),fill=MUTED)
    d.line((x+45,y+22,x+57,y+22),fill=DIM)
    if phase<.65: d.rectangle((x+62,y+21,x+65,y+23),fill=color)
    text(d,(x+3,y+39),label,MUTED)

NODES=[(239,176),(266,148),(266,204),(294,122),(294,176),(294,232),(322,148),(322,204),(350,176)]
EDGES=[(0,1),(0,2),(1,3),(1,4),(2,4),(2,5),(3,6),(4,6),(4,7),(5,7),(6,8),(7,8),(1,2),(6,7)]

def frame(i):
    phase=i/96
    im=Image.new('RGB',(W,H),BG); d=ImageDraw.Draw(im)
    # Subtle pixel field, not a moving or flashing background.
    for y in range(104,269,12):
        for x in range(20,581,12): d.point((x,y),fill=GRID)
    d.rectangle((0,0,W-1,H-1),outline=GRID)
    d.line((24,91,576,91),fill=GRID)
    text(d,(25,21),'MOTIF',GOLD,6)
    text(d,(26,73),'THE EXPERIENCE GRAPH FOR AI AGENTS',INK)
    text(d,(398,26),'SELF-HOSTED / OPEN SOURCE',MUTED)
    text(d,(398,42),'YOUR EXPERIENCE. YOUR INFRA.',MUTED)
    d.rectangle((562,65,568,71),fill=MINT)
    text(d,(452,65),'LOCAL FIRST',MINT)
    for j,(y,col,label) in enumerate([(112,BLUE,'AGENT 01'),(170,MINT,'AGENT 02'),(228,LILAC,'AGENT 03')]):
        terminal(d,29,y,col,label,(phase+j*.21)%1)
        line=[(109,y+20),(151+j*12,y+20),(151+j*12,176),(230,176)]
        d.line(line,fill=GRID,width=1)
        packet(d,line,phase*2+j/3,col)
    center(d,178,111,'CAPTURE',MUTED)
    for a,b in EDGES: d.line([NODES[a],NODES[b]],fill=DIM)
    # Two woven routes carry experience through the durable graph.
    for route,col,offset in [([0,1,4,7,8],GOLD,0),([0,2,4,6,8],MINT,.5)]:
        points=[NODES[n] for n in route]
        for a,b in zip(points,points[1:]): d.line([a,b],fill=DIM,width=2)
        packet(d,points,phase*2+offset,col)
    for n,(x,y) in enumerate(NODES):
        d.rectangle((x-5,y-5,x+5,y+5),fill=BG,outline=DIM)
        d.rectangle((x-2,y-2,x+2,y+2),fill=GOLD if n in (0,4,8) else MUTED)
    d.rectangle((281,163,307,189),fill=PANEL,outline=GOLD)
    # Woven M mark, each square stays on the pixel grid.
    for row,bits in enumerate(FONT['M']):
        for col,bit in enumerate(bits):
            if bit=='1':d.rectangle((287+col*3,166+row*3,289+col*3,168+row*3),fill=GOLD)
    # Review is attached to memory; raw capture itself is not gated.
    d.line([(325,99),(365,99),(365,130),(430,130)],fill=DIM)
    check(d,327,96,GOLD)
    text(d,(341,96),'HUMAN REVIEW',GOLD)
    for points,col,offset in [([(355,176),(389,176),(389,145),(429,145)],MINT,.15), ([(355,176),(389,176),(389,227),(429,227)],LILAC,.65)]:
        d.line(points,fill=DIM)
        packet(d,points,phase*2+offset,col)
    # Recalled memory card.
    d.rectangle((430,116,574,177),fill=PANEL,outline=GRID)
    text(d,(442,126),'RECALL',MINT,2)
    check(d,443,150)
    text(d,(459,151),'REVIEWED MEMORY',INK)
    text(d,(443,164),'WITH ITS SOURCE',MUTED)
    # Learning exports are outcomes + examples, not a trained model claim.
    d.rectangle((430,199,574,260),fill=PANEL,outline=GRID)
    text(d,(442,209),'LEARN',LILAC,2)
    for r in range(3):
        d.rectangle((442,233+r*6,445,235+r*6),fill=LILAC)
        d.line((449,234+r*6,465,234+r*6),fill=MUTED)
    text(d,(477,234),'DATASETS',INK)
    text(d,(477,247),'+ EVALS',MUTED)
    center(d,294,253,'EXPERIENCE GRAPH',GOLD)
    # Source receipts under the graph stay visible throughout the loop.
    center(d,294,266,'TRIED / OBSERVED / REVIEWED',MUTED)
    d.line((24,285,576,285),fill=GRID)
    center(d,300,300,'CAPTURE > REMEMBER > VERIFY > LEARN > ACT',MUTED)
    return im.resize((W*SCALE,H*SCALE),Image.Resampling.NEAREST)

frames=[frame(i) for i in range(96)]
# One shared palette keeps pixel edges stable and the loop small.
palette=frames[0].quantize(colors=32,method=Image.Quantize.MEDIANCUT)
frames=[f.quantize(palette=palette,dither=Image.Dither.NONE) for f in frames]
frames[0].save(OUT/'experience-hero.gif',save_all=True,append_images=frames[1:],duration=100,loop=0,optimize=True,disposal=1)
frame(0).save(OUT/'experience-hero.png',optimize=True)
print('Generated experience-hero.gif and experience-hero.png')
