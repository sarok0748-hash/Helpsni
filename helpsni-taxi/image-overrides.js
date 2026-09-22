(function(){
  var hero="./assets/helpsni-hero.jpg";
  var driver="./assets/helpsni-driver.jpg";
  function apply(){
    document.querySelectorAll('img[src*="28123219"]').forEach(function(img){img.src=hero;img.removeAttribute("srcset");});
    document.querySelectorAll('img[src*="23319099"]').forEach(function(img){img.src=driver;img.removeAttribute("srcset");});
    document.querySelectorAll(".helpsni-phone,.helpsni-phone-large").forEach(function(el){el.style.display="none";});
  }
  apply();
  new MutationObserver(apply).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["src"]});
})();