# One presentation system for the Agent's own private dialogs. No vault/network IO.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if(-not ('SsamRoundedPanel' -as [type])){
 Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing,Accessibility -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;
using System.Runtime.InteropServices;
public static class SsamDialogNative {
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle,int command);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
}
public static class SsamDrawing {
 public static readonly Color Border=Color.FromArgb(222,223,227);
 public static void Surface(Graphics g,RectangleF bounds,float radius,Color fill,Color border){
  if(bounds.Width<=0||bounds.Height<=0)return;
  g.SmoothingMode=SmoothingMode.AntiAlias;g.PixelOffsetMode=PixelOffsetMode.Half;
  float stroke=Math.Max(1f,g.DpiX/96f);
  using(GraphicsPath outer=Rounded(bounds,radius))using(Brush b=new SolidBrush(border.A==0?fill:border))g.FillPath(b,outer);
  if(border.A>0&&bounds.Width>2*stroke&&bounds.Height>2*stroke){
   RectangleF inner=new RectangleF(bounds.X+stroke,bounds.Y+stroke,bounds.Width-2*stroke,bounds.Height-2*stroke);
   using(GraphicsPath p=Rounded(inner,Math.Max(.1f,radius-stroke)))using(Brush b=new SolidBrush(fill))g.FillPath(b,p);
  }
 }
 public static GraphicsPath Rounded(RectangleF r,float radius){
  GraphicsPath p=new GraphicsPath();float d=Math.Min(radius*2,Math.Min(r.Width,r.Height));
  p.AddArc(r.X,r.Y,d,d,180,90);p.AddArc(r.Right-d,r.Y,d,d,270,90);
  p.AddArc(r.Right-d,r.Bottom-d,d,d,0,90);p.AddArc(r.X,r.Bottom-d,d,d,90,90);p.CloseFigure();return p;
 }
}
public class SsamDialogForm : Form {
 public SsamDialogForm(){DoubleBuffered=true;SetStyle(ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.ResizeRedraw,true);}
 protected override void OnPaintBackground(PaintEventArgs e){e.Graphics.Clear(BackColor);}
 protected override void OnShown(EventArgs e){base.OnShown(e);Invalidate(true);Update();}
}
public class SsamRoundedPanel : Panel {
 protected override void OnPaintBackground(PaintEventArgs e){e.Graphics.Clear(Parent==null?Color.FromArgb(250,250,250):Parent.BackColor);}
 public Color FillColor=Color.White; public Color LineColor=Color.FromArgb(222,223,227); public int Radius=9;
 public bool HighlightFocus=true;
 public SsamRoundedPanel(){SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.ResizeRedraw,true);BackColor=Color.FromArgb(250,250,250);}
 protected override void OnPaint(PaintEventArgs e){
  using(Brush background=new SolidBrush(Parent==null?Color.FromArgb(250,250,250):Parent.BackColor))e.Graphics.FillRectangle(background,ClientRectangle);
  SsamDrawing.Surface(e.Graphics,new RectangleF(0,0,Width,Height),Radius,FillColor,HighlightFocus&&ContainsFocus?Color.FromArgb(218,35,55):LineColor);
 }
}
public class SsamRoundedButton : Control, IButtonControl {
 public bool Primary; private bool hover;
 public DialogResult DialogResult {get;set;}
 public SsamRoundedButton(){SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.ResizeRedraw|ControlStyles.Selectable|ControlStyles.StandardClick,true);TabStop=true;AccessibleRole=AccessibleRole.PushButton;}
 public void NotifyDefault(bool value){Invalidate();}
 public void PerformClick(){if(Enabled&&CanSelect)OnClick(EventArgs.Empty);}
 protected override void OnClick(EventArgs e){if(!Enabled)return;Form f=FindForm();if(f!=null&&DialogResult!=DialogResult.None)f.DialogResult=DialogResult;base.OnClick(e);}
 protected override void OnKeyDown(KeyEventArgs e){if(e.KeyCode==Keys.Space){e.Handled=true;e.SuppressKeyPress=true;}base.OnKeyDown(e);}
 protected override void OnKeyUp(KeyEventArgs e){if(e.KeyCode==Keys.Space){PerformClick();e.Handled=true;}base.OnKeyUp(e);}
 protected override void OnGotFocus(EventArgs e){Invalidate();base.OnGotFocus(e);}
 protected override void OnLostFocus(EventArgs e){Invalidate();base.OnLostFocus(e);}
 protected override void OnPaintBackground(PaintEventArgs e){e.Graphics.Clear(Parent==null?SystemColors.Control:Parent.BackColor);}
 protected override AccessibleObject CreateAccessibilityInstance(){return new ButtonAccessibility(this);}
 private class ButtonAccessibility:ControlAccessibleObject {
  readonly SsamRoundedButton owner;public ButtonAccessibility(SsamRoundedButton c):base(c){owner=c;}
  public override string DefaultAction {get{return "Press";}}
  public override void DoDefaultAction(){owner.PerformClick();}
 }
 protected override void OnMouseEnter(EventArgs e){hover=true;Invalidate();base.OnMouseEnter(e);}
 protected override void OnMouseLeave(EventArgs e){hover=false;Invalidate();base.OnMouseLeave(e);}
 protected override void OnEnabledChanged(EventArgs e){Invalidate();base.OnEnabledChanged(e);}
 protected override void OnPaint(PaintEventArgs e){
  using(Brush background=new SolidBrush(Parent==null?Color.FromArgb(250,250,250):Parent.BackColor))e.Graphics.FillRectangle(background,ClientRectangle);
  e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;
  Color fill=Primary?(hover?Color.FromArgb(188,27,45):Color.FromArgb(218,35,55)):(hover?Color.FromArgb(241,242,244):Color.White);
  if(!Enabled)fill=Primary?Color.FromArgb(236,145,154):Color.FromArgb(248,248,249);
  SsamDrawing.Surface(e.Graphics,new RectangleF(0,0,Width,Height),9,fill,Primary?fill:SsamDrawing.Border);
  TextRenderer.DrawText(e.Graphics,Text,Font,ClientRectangle,Primary?Color.White:Color.FromArgb(39,41,46),TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter|TextFormatFlags.SingleLine|TextFormatFlags.NoPrefix|TextFormatFlags.PreserveGraphicsClipping|TextFormatFlags.PreserveGraphicsTranslateTransform);
  if(Focused&&ShowFocusCues){using(GraphicsPath p=SsamDrawing.Rounded(new RectangleF(3.5f,3.5f,Width-7,Height-7),6))using(Pen pen=new Pen(Primary?Color.White:Color.FromArgb(218,35,55),1))e.Graphics.DrawPath(pen,p);}
 }
}
public class SsamRememberBox : Control {
 private bool selected;
 public event EventHandler CheckedChanged;
 public bool Checked {get{return selected;}set{if(selected==value)return;selected=value;Invalidate();AccessibilityNotifyClients(AccessibleEvents.StateChange,-1);if(CheckedChanged!=null)CheckedChanged(this,EventArgs.Empty);}}
 public SsamRememberBox(){SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.ResizeRedraw|ControlStyles.Selectable|ControlStyles.StandardClick,true);TabStop=true;AccessibleRole=AccessibleRole.CheckButton;}
 protected override void OnClick(EventArgs e){if(Enabled)Checked=!Checked;base.OnClick(e);}
 protected override void OnKeyDown(KeyEventArgs e){if(e.KeyCode==Keys.Space){e.Handled=true;e.SuppressKeyPress=true;}base.OnKeyDown(e);}
 protected override void OnKeyUp(KeyEventArgs e){if(e.KeyCode==Keys.Space&&Enabled){Checked=!Checked;e.Handled=true;}base.OnKeyUp(e);}
 protected override void OnGotFocus(EventArgs e){Invalidate();base.OnGotFocus(e);}
 protected override void OnLostFocus(EventArgs e){Invalidate();base.OnLostFocus(e);}
 protected override AccessibleObject CreateAccessibilityInstance(){return new CheckAccessibility(this);}
 private class CheckAccessibility:ControlAccessibleObject {
  readonly SsamRememberBox owner;public CheckAccessibility(SsamRememberBox c):base(c){owner=c;}
  public override AccessibleStates State {get{return base.State|(owner.Checked?AccessibleStates.Checked:0);}}
  public override string DefaultAction {get{return owner.Checked?"Uncheck":"Check";}}
  public override void DoDefaultAction(){if(owner.Enabled)owner.Checked=!owner.Checked;}
 }
 protected override void OnPaintBackground(PaintEventArgs e){e.Graphics.Clear(Parent==null?SystemColors.Control:Parent.BackColor);}
 protected override void OnPaint(PaintEventArgs e){
  using(Brush background=new SolidBrush(Parent==null?Color.FromArgb(250,250,250):Parent.BackColor))e.Graphics.FillRectangle(background,ClientRectangle);
  e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;float factor=e.Graphics.DpiX/96f;float side=16*factor;float y=(Height-side)/2f;
  Color red=Color.FromArgb(218,35,55);Color line=Checked?red:SsamDrawing.Border;
  SsamDrawing.Surface(e.Graphics,new RectangleF(0,y,side,side),3*factor,Checked?red:Color.White,line);
  if(Checked){using(Pen pen=new Pen(Color.White,1.8f*factor)){pen.StartCap=LineCap.Round;pen.EndCap=LineCap.Round;e.Graphics.DrawLines(pen,new PointF[]{new PointF(4*factor,y+8*factor),new PointF(7*factor,y+11*factor),new PointF(12*factor,y+5*factor)});}}
  Rectangle text=new Rectangle((int)(side+9*factor),0,Width-(int)(side+9*factor),Height);
  TextRenderer.DrawText(e.Graphics,Text,Font,text,Enabled?ForeColor:SystemColors.GrayText,TextFormatFlags.VerticalCenter|TextFormatFlags.Left|TextFormatFlags.SingleLine|TextFormatFlags.NoPrefix|TextFormatFlags.PreserveGraphicsClipping|TextFormatFlags.PreserveGraphicsTranslateTransform);
  if(Focused&&ShowFocusCues)ControlPaint.DrawFocusRectangle(e.Graphics,new Rectangle(text.X,3,text.Width-1,Height-6));
 }
}
"@
}
$script:SsamDialogColors=@{Background=[Drawing.ColorTranslator]::FromHtml('#fafafa');Text=[Drawing.ColorTranslator]::FromHtml('#202126');Muted=[Drawing.ColorTranslator]::FromHtml('#676b74');Border=[Drawing.ColorTranslator]::FromHtml('#dedfe3');Primary=[Drawing.ColorTranslator]::FromHtml('#da2337');Error=[Drawing.ColorTranslator]::FromHtml('#a91b2b');Soft=[Drawing.ColorTranslator]::FromHtml('#f0f1f3')}
function New-SsamFont([float]$pixels=14,[Drawing.FontStyle]$style=[Drawing.FontStyle]::Regular){$family=if($style -eq [Drawing.FontStyle]::Bold){'Segoe UI Semibold'}else{'Segoe UI'};return New-Object Drawing.Font($family,$pixels,[Drawing.FontStyle]::Regular,[Drawing.GraphicsUnit]::Pixel)}
function Set-SsamRounded($control,[int]$radius=9){if($control -is [SsamRoundedPanel]){$control.Radius=$radius;$control.Invalidate()}}
function Add-SsamLabel($parent,[string]$text,[int]$x,[int]$y,[int]$width,[int]$height=24,[float]$size=14,[switch]$bold,[switch]$muted,[switch]$center){
 $c=New-Object Windows.Forms.Label;$c.UseMnemonic=$false;$c.Text=$text;$c.SetBounds($x,$y,$width,$height);$c.BackColor=[Drawing.Color]::Transparent
 $weight=if($bold){[Drawing.FontStyle]::Bold}else{[Drawing.FontStyle]::Regular};$c.Font=New-SsamFont $size $weight;$c.ForeColor=if($muted){$script:SsamDialogColors.Muted}else{$script:SsamDialogColors.Text}
 if($center){$c.TextAlign='MiddleCenter'};$parent.Controls.Add($c);return $c
}
function New-SsamDialog([string]$title,[string]$description,[string]$service,[string]$hostName,[int]$width=440){
 $f=New-Object SsamDialogForm;$f.Text='SSAM Agent';$f.StartPosition='CenterScreen';$f.FormBorderStyle='FixedDialog';$f.MaximizeBox=$false;$f.MinimizeBox=$false;$f.TopMost=$true
 $f.AutoScaleMode='Dpi';$f.AutoScaleDimensions=New-Object Drawing.SizeF(96,96);$f.AutoScroll=$true;$f.Font=New-SsamFont;$f.BackColor=$script:SsamDialogColors.Background;$f.ForeColor=$script:SsamDialogColors.Text;$f.ClientSize=New-Object Drawing.Size($width,520)
 $f.Add_Shown({[void][SsamDialogNative]::ShowWindow($this.Handle,5);[void][SsamDialogNative]::SetForegroundWindow($this.Handle);$this.Activate()})
 $bytes=[Convert]::FromBase64String('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');$stream=New-Object IO.MemoryStream(,$bytes);$source=[Drawing.Image]::FromStream($stream);$logo=New-Object Drawing.Bitmap($source);$source.Dispose();$stream.Dispose()
 $brandFont=New-SsamFont 23 ([Drawing.FontStyle]::Bold);$brandWidth=[Windows.Forms.TextRenderer]::MeasureText('SSAM Agent',$brandFont,(New-Object Drawing.Size(400,64)),[Windows.Forms.TextFormatFlags]::NoPadding).Width
 $left=[int](($width-64-12-$brandWidth)/2)
 $picture=New-Object Windows.Forms.PictureBox;$picture.Image=$logo;$picture.SizeMode='Zoom';$picture.SetBounds($left,26,64,64);$f.Controls.Add($picture)
 $brand=Add-SsamLabel $f 'SSAM Agent' ($left+76) 26 ($brandWidth+2) 64 23 -bold;$brand.TextAlign='MiddleLeft'
 $heading=Add-SsamLabel $f $title 46 115 ($width-92) 28 17 -bold -center
 $headingWidth=[Windows.Forms.TextRenderer]::MeasureText($title,$heading.Font,(New-Object Drawing.Size(($width-92),28)),[Windows.Forms.TextFormatFlags]::NoPadding).Width
 $dot=New-Object Windows.Forms.Panel;$dot.SetBounds(([Math]::Max(28,[int](($width-$headingWidth)/2)-19)),125,9,9);$dot.BackColor=$script:SsamDialogColors.Background
 $dot.Add_Paint({$e=$args[1];$e.Graphics.SmoothingMode='AntiAlias';$b=New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml('#d89e20'));try{$e.Graphics.FillEllipse($b,0,0,8,8)}finally{$b.Dispose()}});$f.Controls.Add($dot)
 $measureFont=New-SsamFont 13;$size=[Windows.Forms.TextRenderer]::MeasureText($description,$measureFont,(New-Object Drawing.Size(($width-56),1000)),[Windows.Forms.TextFormatFlags]::WordBreak);$measureFont.Dispose()
 $descHeight=[Math]::Max(20,$size.Height+2);$null=Add-SsamLabel $f $description 28 155 ($width-56) $descHeight 13 -muted -center;$y=155+$descHeight+20
 if($hostName){
  $card=New-Object SsamRoundedPanel;$card.FillColor=$script:SsamDialogColors.Soft;$card.LineColor=[Drawing.Color]::Transparent;$card.HighlightFocus=$false;$card.SetBounds(28,$y,($width-56),60);$f.Controls.Add($card)
  $null=Add-SsamLabel $card $service 13 10 ($width-82) 16 11 -muted
  $hostFont=New-SsamFont 12;$hostSize=[Windows.Forms.TextRenderer]::MeasureText($hostName,$hostFont,(New-Object Drawing.Size(($width-82),1000)),[Windows.Forms.TextFormatFlags]::WordBreak);$hostFont.Dispose();$card.Height=[Math]::Max(60,$hostSize.Height+40)
  $null=Add-SsamLabel $card $hostName 13 31 ($width-82) ($card.Height-36) 12;$y+=$card.Height+20
 }
 $f.Tag=@{Logo=$logo;ContentY=$y;ContentWidth=($width-56);Dot=$dot}
 $f.Add_Disposed({if($this.Tag -and $this.Tag.Logo){$this.Tag.Logo.Dispose()}});return $f
}
function Add-SsamField($parent,[string]$label,[int]$y,[switch]$secret,[string]$value=''){
 $width=$parent.ClientSize.Width-56;$null=Add-SsamLabel $parent $label 28 $y $width 17 12 -bold
 $panel=New-Object SsamRoundedPanel;$panel.SetBounds(28,($y+24),$width,44);$parent.Controls.Add($panel)
 $input=New-Object Windows.Forms.TextBox;$input.BorderStyle='None';$input.Font=New-SsamFont 14;$input.BackColor=[Drawing.Color]::White;$input.ForeColor=$script:SsamDialogColors.Text;$input.SetBounds(13,12,($width-28),22)
 $input.UseSystemPasswordChar=[bool]$secret;$input.Text=$value;$input.AccessibleName=$label;$panel.Controls.Add($input);$input.Add_Enter({$this.Parent.Invalidate()});$input.Add_Leave({$this.Parent.Invalidate()});return $input
}
function Add-SsamButton($parent,[string]$text,[int]$x,[int]$y,[int]$width,[switch]$primary){$c=New-Object SsamRoundedButton;$c.Primary=[bool]$primary;$c.Text=$text;$c.SetBounds($x,$y,$width,44);$c.Font=New-SsamFont 14;$parent.Controls.Add($c);return $c}
function Add-SsamRemember($parent,[int]$y){$c=New-Object SsamRememberBox;$c.Text='Remember on this device';$c.Checked=$false;$c.Font=New-SsamFont 12;$c.ForeColor=$script:SsamDialogColors.Muted;$c.SetBounds(28,$y,($parent.ClientSize.Width-56),24);$parent.Controls.Add($c);return $c}
function Add-SsamFeedback($form,[int]$y){
 $panel=New-Object SsamRoundedPanel;$panel.FillColor=[Drawing.ColorTranslator]::FromHtml('#fcecef');$panel.LineColor=[Drawing.Color]::Transparent;$panel.HighlightFocus=$false;$panel.SetBounds(28,$y,($form.ClientSize.Width-56),0);$panel.Visible=$false;$form.Controls.Add($panel)
 $label=Add-SsamLabel $panel '' 13 10 ($panel.Width-26) 38 13;$label.ForeColor=$script:SsamDialogColors.Error
 $label.Tag=@{Form=$form;Panel=$panel;BaseY=$y;LastHeight=0}
 $label.Add_TextChanged({
  $state=$this.Tag;$panel=$state.Panel;$form=$state.Form;$form.SuspendLayout();$newHeight=if($this.Text){58}else{0};$shift=$newHeight-$state.LastHeight
  foreach($control in $form.Controls){if($control -ne $panel -and $control.Top -ge $state.BaseY){$control.Top+=$shift}}
  $panel.Height=$newHeight;$panel.Visible=($newHeight -gt 0);$state.LastHeight=$newHeight
  if($shift){$form.ClientSize=New-Object Drawing.Size($form.ClientSize.Width,($form.ClientSize.Height+$shift));$form.AutoScrollMinSize=New-Object Drawing.Size(0,($form.AutoScrollMinSize.Height+$shift))};$form.ResumeLayout($true);$form.Invalidate($true);$form.Update()
 });return $label
}
function Complete-SsamDialog($form,[int]$afterY,[string]$privacy='Your credentials stay on this device.'){
 $width=$form.ClientSize.Width;$null=Add-SsamLabel $form $privacy 28 ($afterY+18) ($width-56) 22 12 -muted -center
 $null=Add-SsamLabel $form 'Private window' 28 ($afterY+66) 150 18 11 -muted
 $footer=Add-SsamLabel $form 'ssam.pro' ($width-128) ($afterY+66) 100 18 11 -muted;$footer.TextAlign='MiddleRight'
 $fullHeight=$afterY+102;$maxHeight=[Windows.Forms.Screen]::PrimaryScreen.WorkingArea.Height-80;$form.ClientSize=New-Object Drawing.Size($width,([Math]::Min($fullHeight,$maxHeight)));$form.AutoScrollMinSize=New-Object Drawing.Size(0,$fullHeight)
}