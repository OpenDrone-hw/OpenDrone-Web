"""STEP -> per-base tessellation + per-leaf placement.
usage: step_extract.py in.step out.pkl   (python3 with OCP, numpy)
Every distinct part is meshed once (0.03 mm deflection); every occurrence keeps its
4x4 placement, name and CAD colours. units.py groups the occurrences into parts."""
import sys, pickle
import numpy as np
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString
from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ColorGen, XCAFDoc_ColorSurf
from OCP.TDF import TDF_LabelSequence, TDF_Label
from OCP.TDataStd import TDataStd_Name
from OCP.Quantity import Quantity_Color
from OCP.TopLoc import TopLoc_Location
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
from OCP.TopoDS import TopoDS
from OCP.BRep import BRep_Tool
src, out = sys.argv[1], sys.argv[2]
doc = TDocStd_Document(TCollection_ExtendedString("doc"))
r = STEPCAFControl_Reader(); r.SetNameMode(True); r.SetColorMode(True)
assert r.ReadFile(src) == 1
r.Transfer(doc)
st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
ct = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
def name(l):
    a = TDataStd_Name()
    return a.Get().ToExtString() if l.FindAttribute(TDataStd_Name.GetID_s(), a) else "?"
def col(shape):
    c = Quantity_Color()
    for t in (XCAFDoc_ColorSurf, XCAFDoc_ColorGen):
        if ct.GetColor(shape, t, c): return (round(c.Red(),3), round(c.Green(),3), round(c.Blue(),3))
    return None
bases = {}   # label tag string -> dict
leaves = []
def lkey(l):
    from OCP.TDF import TDF_Tool
    from OCP.TCollection import TCollection_AsciiString
    s = TCollection_AsciiString(); TDF_Tool.Entry_s(l, s); return s.ToCString()
def tess(l):
    k = lkey(l)
    if k in bases: return k
    shape = st.GetShape_s(l)
    BRepMesh_IncrementalMesh(shape, 0.03, False, 0.4, True)
    base_col = col(shape)
    if base_col is None:
        c0 = Quantity_Color()
        if ct.GetColor(l, c0): base_col = (round(c0.Red(),3), round(c0.Green(),3), round(c0.Blue(),3))
    groups = {}  # colour -> (verts list, tris list)
    ex = TopExp_Explorer(shape, TopAbs_FACE)
    while ex.More():
        f = TopoDS.Face_s(ex.Current()); loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(f, loc)
        if tri is not None:
            fc = col(f) or base_col or (0.6,0.6,0.6)
            g = groups.setdefault(fc, ([], []))
            tr = loc.Transformation()
            n = tri.NbNodes(); off = sum(len(v) for v in g[0])
            P = np.array([[tri.Node(i).X(), tri.Node(i).Y(), tri.Node(i).Z()] for i in range(1, n+1)])
            if not loc.IsIdentity():
                M = np.array([[tr.Value(i,j) for j in range(1,5)] for i in range(1,4)])
                P = P @ M[:,:3].T + M[:,3]
            T = np.array([[tri.Triangle(i).Value(1)-1, tri.Triangle(i).Value(2)-1, tri.Triangle(i).Value(3)-1] for i in range(1, tri.NbTriangles()+1)])
            if f.Orientation() == TopAbs_REVERSED: T = T[:, ::-1]
            g[0].append(P); g[1].append(T + off)
        ex.Next()
    out_groups = {}
    for c,(vs,ts) in groups.items():
        out_groups[c] = (np.concatenate(vs).astype(np.float32), np.concatenate(ts).astype(np.int32))
    bases[k] = dict(name=name(l), groups=out_groups, color=base_col)
    return k
def walk(l, loc, path):
    if st.IsAssembly_s(l):
        cs = TDF_LabelSequence(); st.GetComponents_s(l, cs)
        for i in range(1, cs.Length()+1):
            c = cs.Value(i); rl = TDF_Label(); st.GetReferredShape_s(c, rl)
            walk(rl, loc.Multiplied(st.GetLocation_s(c)), path + [name(c)])
    else:
        k = tess(l)
        tr = loc.Transformation()
        M = np.array([[tr.Value(i,j) for j in range(1,5)] for i in range(1,4)] + [[0,0,0,1]])
        leaves.append(dict(base=k, path=path, M=M))
roots = TDF_LabelSequence(); st.GetFreeShapes(roots)
for i in range(1, roots.Length()+1): walk(roots.Value(i), TopLoc_Location(), [name(roots.Value(i))])
pickle.dump(dict(bases=bases, leaves=leaves), open(out, 'wb'))
print(len(leaves), 'leaves', len(bases), 'bases', sum(len(t) for b in bases.values() for _,t in b['groups'].values()), 'tris')
